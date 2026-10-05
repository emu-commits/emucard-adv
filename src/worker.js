// The emulator in a Web Worker: owns the esp32sim WebAssembly instance, paces it to the wall
// clock, and relays screens, serial output and card changes to the page.
//
// Page -> worker: {op: 'init' | 'boot' | 'reset' | 'key' | 'pause' | 'resume' | 'get-sd' | 'spin-skip'}
// Worker -> page: {ready} {booted} {frame} {serial} {stats} {sdGeneration} {sd} {error} {log}
import { createJitHost } from './jit.mjs';

const BOARD = 'cardputer-adv';
const FLASH_MB = 8;
const LOAD_ROM = 0, LOAD_FLASH = 5, LOAD_SD = 8;

let wasm = null;
let emu = 0;
let rom = null;
let firmware = null;
let running = false;
let paused = false;
let spinSkip = true;
let cpuHz = 240e6;
let t0 = 0;
let lastStat = { wall: 0, cycles: 0, insns: 0 };
let lastGen = -1;

const enc = new TextEncoder();
const dec = new TextDecoder();
const mem = () => new Uint8Array(wasm.memory.buffer);
const jit = createJitHost(() => wasm);

function withBytes(bytes, fn) {
  const p = wasm.esp32sim_alloc(bytes.length);
  mem().set(bytes, p);
  try { return fn(p, bytes.length); } finally { wasm.esp32sim_free(p, bytes.length); }
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function init({ wasmUrl, romUrl }) {
  const [wasmBytes, romBytes] = await Promise.all([fetchBytes(wasmUrl), fetchBytes(romUrl)]);
  rom = romBytes;
  const imports = {
    env: {
      ...jit.imports,
      host_log: (p, n) => postMessage({ log: dec.decode(mem().subarray(p, p + n)) }),
      host_profile_now: () => performance.now() * 1000,
    },
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  wasm = instance.exports;
  postMessage({ ready: true });
}

function currentSd() {
  if (!emu) return null;
  const len = wasm.esp32sim_sd_len(emu);
  if (!len) return null;
  return mem().slice(wasm.esp32sim_sd_ptr(emu), wasm.esp32sim_sd_ptr(emu) + len);
}

function boot(fw, sd) {
  running = false;
  if (emu) { wasm.esp32sim_delete(emu); emu = 0; }
  firmware = fw;
  emu = withBytes(enc.encode(BOARD), (p, n) => wasm.esp32sim_new(p, n, FLASH_MB, 0));
  if (!emu) throw new Error('could not create the emulator');
  wasm.esp32sim_set_jit(emu, 1);
  wasm.esp32sim_set_spin_skip(emu, spinSkip ? 1 : 0);
  cpuHz = wasm.esp32sim_cpu_hz(emu);
  const check = (what, rc) => { if (rc !== 0) throw new Error(`${what} was rejected (rc ${rc})`); };
  check('mask ROM', withBytes(rom, (p, n) => wasm.esp32sim_load(emu, LOAD_ROM, p, n)));
  check('firmware', withBytes(fw, (p, n) => wasm.esp32sim_load(emu, LOAD_FLASH, p, n)));
  if (sd) check('SD card image', withBytes(sd, (p, n) => wasm.esp32sim_load(emu, LOAD_SD, p, n)));
  check('boot', wasm.esp32sim_boot(emu, 0));
  lastGen = wasm.esp32sim_sd_generation(emu);
  running = true;
  t0 = performance.now();
  lastStat = { wall: t0, cycles: 0, insns: 0 };
  postMessage({ booted: true });
  loop();
}

function drain() {
  const n = wasm.esp32sim_out_take(emu);
  for (let i = 0; i < n; i++) {
    const kind = wasm.esp32sim_out_kind(emu, i);
    const p = wasm.esp32sim_out_ptr(emu, i);
    const len = wasm.esp32sim_out_len(emu, i);
    if (kind === 1) {
      let msg;
      try { msg = JSON.parse(dec.decode(mem().subarray(p, p + len))); } catch { continue; }
      if (msg.t === 'serial' && msg.src === 'usb') postMessage({ serial: msg.data });
      else if (msg.t === 'emu') postMessage({ log: msg.msg });
    } else {
      const tag = mem()[p];
      if (tag !== 1 && tag !== 5) continue;              // 1: Cardputer screen, 5: TERM512 panel
      const buf = mem().slice(p, p + len).buffer;
      postMessage({ frame: buf }, [buf]);
    }
  }
}

const channel = new MessageChannel();
channel.port1.onmessage = () => loop();

function loop() {
  if (!running || paused) return;
  const now = performance.now();
  let cur = wasm.esp32sim_cycles(emu);
  let target = ((now - t0) / 1000) * cpuHz;
  // Hopelessly behind (booting, a slow device): run as fast as possible without bursting.
  if (target - cur > cpuHz * 0.25) { t0 = now - (cur / cpuHz) * 1000; target = cur + cpuHz * 0.02; }
  while (cur < target) {
    const rc = wasm.esp32sim_run(emu, Math.min(target - cur, 4_000_000), Date.now());
    cur = wasm.esp32sim_cycles(emu);
    drain();
    if (rc !== 0) { running = false; postMessage({ error: `the emulated chip stopped (code ${rc})` }); return; }
    if (performance.now() - now > 16) break;            // let input messages through
  }
  const wall = performance.now();
  if (wall - lastStat.wall >= 1000) {
    const insns = wasm.esp32sim_insns(emu);
    postMessage({
      stats: {
        speed: (cur - lastStat.cycles) / cpuHz / ((wall - lastStat.wall) / 1000),
        mips: (insns - lastStat.insns) / (wall - lastStat.wall) / 1000,
        seconds: cur / cpuHz,
      },
    });
    lastStat = { wall, cycles: cur, insns };
  }
  const gen = wasm.esp32sim_sd_generation(emu);
  if (gen !== lastGen) { lastGen = gen; postMessage({ sdGeneration: gen }); }
  if (cur < target) channel.port2.postMessage(0);
  else setTimeout(loop, Math.max(1, Math.min(15, (cur / cpuHz) * 1000 - (performance.now() - t0))));
}

onmessage = async ({ data: m }) => {
  try {
    switch (m.op) {
      case 'init': await init(m); break;
      case 'boot': paused = false; boot(new Uint8Array(m.firmware), m.sd ? new Uint8Array(m.sd) : null); break;
      case 'reset': {
        // Power cycle: the card stays in the slot with whatever the firmware wrote to it,
        // unless the page hands over a new one.
        const sd = m.sd ? new Uint8Array(m.sd) : currentSd();
        paused = false;
        boot(firmware, sd);
        break;
      }
      case 'key': if (emu) wasm.esp32sim_key(emu, m.code, m.down ? 1 : 0); break;
      case 'button':
        // A board button through the page protocol: active low, as wired.
        if (emu) withBytes(enc.encode(JSON.stringify({ t: 'btn', pin: m.pin, v: m.down ? '1' : '0' })), (p, n) => wasm.esp32sim_in_text(emu, p, n));
        break;
      case 'pause': paused = true; break;
      case 'resume':
        if (paused) {
          paused = false;
          if (emu) { t0 = performance.now() - (wasm.esp32sim_cycles(emu) / cpuHz) * 1000; loop(); }
        }
        break;
      case 'spin-skip': spinSkip = !!m.on; if (emu) wasm.esp32sim_set_spin_skip(emu, spinSkip ? 1 : 0); break;
      case 'get-sd': {
        const sd = currentSd();
        const gen = emu ? wasm.esp32sim_sd_generation(emu) : 0;
        if (sd) postMessage({ sd: sd.buffer, generation: gen, id: m.id }, [sd.buffer]);
        else postMessage({ sd: null, id: m.id });
        break;
      }
      default: break;
    }
  } catch (err) {
    running = false;
    postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
