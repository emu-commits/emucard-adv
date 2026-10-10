// Page wiring: firmware download, the emulator worker, screens, keyboards, the microSD card.
import { chordForEvent, CODE } from './keymap.js';
import { createKeyboard } from './keyboard.js';
import { createSdBrowser, download } from './sdbrowser.js';
import { formatImage } from './fat.js';
import * as storage from './storage.js';

const $ = (id) => document.getElementById(id);
const FIRMWARE_BASE = 'https://raw.githubusercontent.com/engneer-hamachan/area512/main/firmware/';
const DEFAULT_CARD_MB = 64;
const asset = (path) => new URL(path, document.baseURI).href;

const pref = {
  get(k, d) { try { const v = localStorage.getItem('emucard.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('emucard.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---- status --------------------------------------------------------------------------------

const overlay = $('overlay');
function showOverlay(text) { overlay.textContent = text; overlay.hidden = !text; }
let statusBase = '';
let statusNote = '';
function renderStatus() { $('status').textContent = [statusBase, statusNote].filter(Boolean).join(' · '); }
function note(text, ms = 4000) {
  statusNote = text;
  renderStatus();
  if (ms) setTimeout(() => { if (statusNote === text) { statusNote = ''; renderStatus(); } }, ms);
}

// ---- screens -------------------------------------------------------------------------------

const lcd = $('lcd').getContext('2d');
const ext = $('ext').getContext('2d');
let gotFrame = false;

function drawFrame(buf) {
  const b = new Uint8Array(buf);
  const tag = b[0];
  const w = b[1] | (b[2] << 8);
  const h = b[3] | (b[4] << 8);
  if (!w || !h || b.length < 5 + w * h * 2) return;
  const canvas = tag === 5 ? $('ext') : $('lcd');
  const ctx = tag === 5 ? ext : lcd;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const img = ctx.createImageData(w, h);
  const px = img.data;
  for (let i = 0, o = 5; i < w * h; i++, o += 2) {
    const v = b[o] | (b[o + 1] << 8);
    const r = v >> 11, g = (v >> 5) & 63, bl = v & 31;
    px[i * 4] = (r << 3) | (r >> 2);
    px[i * 4 + 1] = (g << 2) | (g >> 4);
    px[i * 4 + 2] = (bl << 3) | (bl >> 2);
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (tag === 5) $('lid').hidden = false;
  else if (!gotFrame) { gotFrame = true; showOverlay(''); }
}

// ---- worker --------------------------------------------------------------------------------

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let requestId = 0;
let ready = null;
let firmwareBytes = null;
let card = null;          // the card image the page knows about (saved copy)

function request(op, extra = {}) {
  const id = ++requestId;
  return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ op, id, ...extra }); });
}

const consoleEl = $('console');
let consoleText = '';
function appendConsole(text) {
  consoleText = (consoleText + text).slice(-60000);
  if (!$('console-panel').hidden) {
    const atEnd = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 8;
    consoleEl.textContent = consoleText;
    if (atEnd) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
}

let saveTimer = 0;
let ledTimer = 0;
worker.onmessage = ({ data: m }) => {
  if (m.ready) ready?.resolve();
  if (m.frame) drawFrame(m.frame);
  if (m.serial) appendConsole(m.serial);
  if (m.log) console.debug('[emu]', m.log);
  if (m.booted) statusBase = 'running';
  if (m.stats) {
    const s = m.stats;
    statusBase = `${s.seconds.toFixed(0)} s emulated · ${(s.speed * 100).toFixed(0)}% speed`;
    renderStatus();
  }
  if (m.sdGeneration !== undefined) {
    $('sd-led').classList.add('on');
    clearTimeout(ledTimer);
    ledTimer = setTimeout(() => $('sd-led').classList.remove('on'), 120);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCard, 2000);
  }
  if (m.error) { showOverlay('Error: ' + m.error); note(m.error, 0); }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
worker.onerror = (ev) => showOverlay('The emulator failed to start: ' + (ev.message || 'worker error'));

async function saveCard() {
  const r = await request('get-sd');
  if (!r.sd) return;
  card = new Uint8Array(r.sd);
  const n = await storage.saveCard(card);
  if (n) note('card saved');
}

// ---- firmware ------------------------------------------------------------------------------

async function getFirmware(name) {
  const cached = await storage.getFirmware(name);
  try {
    showOverlay(`Downloading ${name}…`);
    const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
    const res = await fetch(FIRMWARE_BASE + encodeURIComponent(name), { headers, cache: 'no-cache' });
    if (res.status === 304 && cached) return new Uint8Array(cached.data);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = new Uint8Array(await res.arrayBuffer());
    await storage.putFirmware(name, { data: data.buffer, etag: res.headers.get('ETag'), fetched: Date.now() });
    return data;
  } catch (err) {
    if (cached) { note(`offline: using the saved copy of ${name}`); return new Uint8Array(cached.data); }
    throw new Error(`could not download ${name} (${err.message})`);
  }
}

async function bootFirmware(bytes, label) {
  await ready.promise;
  firmwareBytes = bytes;
  gotFrame = false;
  $('lid').hidden = true;
  showOverlay(`Booting ${label}…`);
  consoleText = '';
  worker.postMessage({ op: 'boot', firmware: bytes.buffer.slice(0), sd: card ? card.buffer.slice(0) : null });
}

async function loadSelected() {
  const name = $('firmware').value;
  if (name === 'local') return;                      // the file already loaded stays running
  pref.set('firmware', name);
  try {
    await bootFirmware(await getFirmware(name), name);
  } catch (err) {
    showOverlay(err.message);
  }
}

$('firmware').addEventListener('change', loadSelected);
// Opening the picker straight from the button click keeps the user gesture browsers require.
$('btn-load').addEventListener('click', () => $('firmware-file').click());
$('firmware-file').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let opt = $('firmware').querySelector('option[data-local]');
    if (!opt) { opt = document.createElement('option'); opt.dataset.local = '1'; opt.value = 'local'; $('firmware').append(opt); }
    opt.textContent = f.name;
    $('firmware').value = 'local';
    await bootFirmware(bytes, f.name);
  } catch (err) {
    showOverlay(err.message);
  }
});

// ---- keyboards -----------------------------------------------------------------------------

const sendKey = (code, down) => worker.postMessage({ op: 'key', code, down });
const keyboard = createKeyboard($('keyboard'), sendKey);

const physical = new Map();   // KeyboardEvent.code -> codes pressed for it (modifiers first)
const dialogOpen = () => document.querySelector('dialog[open]');

window.addEventListener('keydown', (ev) => {
  if (dialogOpen() || ev.target.closest?.('input, select, textarea')) return;
  const chord = chordForEvent(ev);
  if (!chord) return;
  ev.preventDefault();
  if (ev.repeat || physical.has(ev.code)) return;     // the firmware repeats keys itself
  const codes = [];
  if (chord.fn) codes.push(CODE.Fn);
  if (chord.ctrl) codes.push(CODE.Ctrl);
  if (chord.alt) codes.push(CODE.Alt);
  if (chord.shift) codes.push(CODE.Shift);
  codes.push(chord.code);
  physical.set(ev.code, codes);
  for (const c of codes) { sendKey(c, true); keyboard.show(c, true); }
});

window.addEventListener('keyup', (ev) => {
  const codes = physical.get(ev.code);
  if (!codes) return;
  physical.delete(ev.code);
  for (const c of codes.slice().reverse()) { sendKey(c, false); keyboard.show(c, false); }
});

function releaseAll() {
  for (const codes of physical.values()) for (const c of codes) { sendKey(c, false); keyboard.show(c, false); }
  physical.clear();
  keyboard.reset();
}
window.addEventListener('blur', releaseAll);

// ---- buttons -------------------------------------------------------------------------------

$('btn-reset').addEventListener('click', () => {
  if (!firmwareBytes) return;
  releaseAll();
  gotFrame = false;
  $('lid').hidden = true;
  showOverlay('Restarting…');
  worker.postMessage({ op: 'reset' });
});

const g0 = $('btn-g0');
g0.disabled = false;
g0.title = 'G0 button';
g0.addEventListener('pointerdown', () => worker.postMessage({ op: 'button', pin: 0, down: true }));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) g0.addEventListener(ev, () => worker.postMessage({ op: 'button', pin: 0, down: false }));

const sdBrowser = createSdBrowser();
$('btn-sd').addEventListener('click', async () => {
  releaseAll();
  worker.postMessage({ op: 'pause' });
  const r = await request('get-sd');
  const img = r.sd ? new Uint8Array(r.sd) : card || formatImage(DEFAULT_CARD_MB * 1048576);
  const { image, changed } = await sdBrowser.open(img);
  if (changed) {
    card = image;
    await storage.saveCard(card);
    gotFrame = false;
    showOverlay('Card changed — restarting…');
    worker.postMessage({ op: 'reset', sd: card.buffer.slice(0) });
  } else {
    worker.postMessage({ op: 'resume' });
  }
});

const menu = $('menu');
$('btn-menu').addEventListener('click', (ev) => {
  ev.stopPropagation();
  menu.hidden = !menu.hidden;
  $('btn-menu').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (ev) => { if (!menu.contains(ev.target)) menu.hidden = true; });

$('opt-fast').checked = pref.get('fast', true);
worker.postMessage({ op: 'spin-skip', on: $('opt-fast').checked });
$('opt-fast').addEventListener('change', (ev) => {
  pref.set('fast', ev.target.checked);
  worker.postMessage({ op: 'spin-skip', on: ev.target.checked });
});

$('opt-console').checked = pref.get('console', false);
const syncConsole = () => {
  $('console-panel').hidden = !$('opt-console').checked;
  if ($('opt-console').checked) { $('console-panel').open = true; consoleEl.textContent = consoleText; }
};
syncConsole();
$('opt-console').addEventListener('change', () => { pref.set('console', $('opt-console').checked); syncConsole(); });

$('btn-shot').addEventListener('click', () => {
  menu.hidden = true;
  const scale = 3;
  const lid = !$('lid').hidden;
  const sources = lid ? [$('ext'), $('lcd')] : [$('lcd')];
  const out = document.createElement('canvas');
  out.width = Math.max(...sources.map((c) => c.width)) * scale;
  out.height = sources.reduce((h, c) => h + c.height * scale, 0) + (lid ? 12 : 0);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of sources) {
    ctx.drawImage(c, (out.width - c.width * scale) / 2, y, c.width * scale, c.height * scale);
    y += c.height * scale + 12;
  }
  out.toBlob((blob) => download('cardputer.png', blob, 'image/png'));
});

$('btn-help').addEventListener('click', () => { menu.hidden = true; $('help-dialog').showModal(); });

// Pause in the background: saves battery and keeps the card saved.
document.addEventListener('visibilitychange', async () => {
  if (!firmwareBytes || dialogOpen()) return;
  if (document.hidden) { releaseAll(); worker.postMessage({ op: 'pause' }); await saveCard(); }
  else worker.postMessage({ op: 'resume' });
});

// ---- start ---------------------------------------------------------------------------------

async function start() {
  ready = {};
  ready.promise = new Promise((resolve) => { ready.resolve = resolve; });
  showOverlay('Loading the emulator…');
  worker.postMessage({ op: 'init', wasmUrl: asset('vendor/esp32sim.wasm'), romUrl: asset('vendor/esp32s3_rev0_rom.elf') });
  card = await storage.loadCard();
  if (!card) {
    card = formatImage(DEFAULT_CARD_MB * 1048576);
    storage.saveCard(card);
  }
  const fw = pref.get('firmware', 'Area512Adv.bin');
  $('firmware').value = [...$('firmware').options].some((o) => o.value === fw) ? fw : 'Area512Adv.bin';
  await loadSelected();
}

start();

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !location.hostname.match(/^(localhost|127\.)/)) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
