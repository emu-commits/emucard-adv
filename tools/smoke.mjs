// Boot real AREA512 firmware headlessly through the WASM core and check the things that matter:
// the SD card mounts, the firmware writes its data folder to it, the Cardputer screen draws,
// and keys typed on the TCA8418 change what is on screen.
//
//   node tools/smoke.mjs [firmware.bin]     (default: download Area512Adv.bin from upstream)
import fs from 'node:fs';
import { createJitHost } from '../src/jit.mjs';
import { FatVolume, formatImage } from '../src/fat.js';

const root = new URL('..', import.meta.url);
const FW_URL = 'https://raw.githubusercontent.com/engneer-hamachan/area512/main/firmware/Area512Adv.bin';

async function firmware() {
  if (process.argv[2]) return new Uint8Array(fs.readFileSync(process.argv[2]));
  const res = await fetch(FW_URL);
  if (!res.ok) throw new Error('firmware download: HTTP ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

let wasm;
const jit = createJitHost(() => wasm);
const dec = new TextDecoder();
const { instance } = await WebAssembly.instantiate(fs.readFileSync(new URL('vendor/esp32sim.wasm', root)), {
  env: { ...jit.imports, host_log: () => {}, host_profile_now: () => 0 },
});
wasm = instance.exports;
const mem = () => new Uint8Array(wasm.memory.buffer);
const withBytes = (b, f) => { const p = wasm.esp32sim_alloc(b.length); mem().set(b, p); try { return f(p, b.length); } finally { wasm.esp32sim_free(p, b.length); } };

const emu = withBytes(new TextEncoder().encode('cardputer-adv'), (p, n) => wasm.esp32sim_new(p, n, 8, 0));
wasm.esp32sim_set_jit(emu, 1);
wasm.esp32sim_set_spin_skip(emu, 1);
const ok = (what, rc) => { if (rc !== 0) throw new Error(what + ' failed: ' + rc); };
ok('rom', withBytes(fs.readFileSync(new URL('vendor/esp32s3_rev0_rom.elf', root)), (p, n) => wasm.esp32sim_load(emu, 0, p, n)));
ok('firmware', withBytes(await firmware(), (p, n) => wasm.esp32sim_load(emu, 5, p, n)));
ok('sd', withBytes(formatImage(64 * 1024 * 1024), (p, n) => wasm.esp32sim_load(emu, 8, p, n)));
ok('boot', wasm.esp32sim_boot(emu, 0));

const hz = wasm.esp32sim_cpu_hz(emu);
let serial = '';
let frame = null;
const t0 = Date.now();
function runUntil(seconds) {
  while (wasm.esp32sim_cycles(emu) < seconds * hz) {
    if (wasm.esp32sim_run(emu, 4_000_000, Date.now()) !== 0) throw new Error('chip stopped');
    const n = wasm.esp32sim_out_take(emu);
    for (let i = 0; i < n; i++) {
      const p = wasm.esp32sim_out_ptr(emu, i), len = wasm.esp32sim_out_len(emu, i);
      if (wasm.esp32sim_out_kind(emu, i) === 1) {
        const m = JSON.parse(dec.decode(mem().subarray(p, p + len)));
        if (m.t === 'serial' && m.src === 'usb') serial += m.data;
      } else if (mem()[p] === 1) frame = mem().slice(p, p + len);
    }
  }
}
const lit = (f) => { let n = 0; for (let i = 5; i < f.length; i += 2) if (f[i] | f[i + 1]) n++; return n; };
const key = (code) => { wasm.esp32sim_key(emu, code, 1); wasm.esp32sim_key(emu, code, 0); };

const checks = [];
const check = (name, pass, detail = '') => { checks.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

runUntil(14);
check('SD card mounts', serial.includes('after fat mount') && !serial.includes('sdmmc_card_init failed'));
check('board detected as Cardputer ADV', serial.includes('board_M5CardputerADV'));
check('keyboard controller found', !serial.includes('TCA8418 not responding'));
const sd = mem().slice(wasm.esp32sim_sd_ptr(emu), wasm.esp32sim_sd_ptr(emu) + wasm.esp32sim_sd_len(emu));
const card = new FatVolume(sd);
check('firmware seeded the card', card.exists('/Area512_data/home/game'), card.walk('/').length + ' entries');
check('screen draws the UI', frame && lit(frame) > 3000, frame ? lit(frame) + ' lit pixels' : 'no frame');
const before = frame;
key(43); runUntil(14.5); key(67); runUntil(16);
check('keys change the screen', frame && before && Buffer.compare(Buffer.from(frame), Buffer.from(before)) !== 0);
console.log(`16 emulated seconds in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(checks.every(Boolean) ? 0 : 1);
