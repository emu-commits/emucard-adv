import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, CODE, codeAt, chordForEvent } from '../src/keymap.js';

test('56 keys with unique TCA8418 codes', () => {
  assert.equal(KEYS.length, 56);
  assert.equal(new Set(KEYS.map((k) => k.code)).size, 56);
});

test('codes match the firmware lookup table', () => {
  // A sample of cardputer_lookup_key() in AREA512 console/keyboard.cpp.
  const expect = { 1: '`', 2: 'tab', 3: 'fn', 4: 'ctrl', 5: '1', 6: 'q', 7: 'aa', 8: 'opt', 13: 'a', 14: 'alt', 18: 'z',
    52: 'p', 55: '_', 57: ';', 61: '=', 63: "'", 64: '/', 65: 'del', 66: '\\', 67: 'ok', 68: 'space' };
  for (const [code, label] of Object.entries(expect)) {
    assert.equal(KEYS.find((k) => k.code === +code).label, label, `code ${code}`);
  }
  assert.equal(codeAt(3, 13), CODE.Space);
});

const ev = (key, extra = {}) => ({ key, code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });

test('host characters become the Cardputer chord that types them', () => {
  assert.deepEqual(pick(chordForEvent(ev('a'))), { code: 13, shift: false });
  assert.deepEqual(pick(chordForEvent(ev('A', { shiftKey: true }))), { code: 13, shift: true });
  assert.deepEqual(pick(chordForEvent(ev('!', { shiftKey: true }))), { code: 5, shift: true });
  // The firmware's "_" key types "-" when shifted.
  assert.deepEqual(pick(chordForEvent(ev('-'))), { code: 55, shift: true });
  assert.deepEqual(pick(chordForEvent(ev('_', { shiftKey: true }))), { code: 55, shift: false });
});

test('arrows, escape and ctrl', () => {
  const up = chordForEvent(ev('ArrowUp'));
  assert.equal(up.fn, true);
  assert.equal(up.code, 57);
  assert.equal(chordForEvent(ev('Escape')).code, 1);
  const ctrlC = chordForEvent(ev('c', { ctrlKey: true, code: 'KeyC' }));
  assert.equal(ctrlC.ctrl, true);
  assert.equal(ctrlC.code, 28);
  assert.equal(chordForEvent(ev('F5')), null);
});

function pick(c) { return { code: c.code, shift: c.shift }; }
