// The Cardputer ADV keyboard: 4 rows x 14 keys on a TCA8418 keypad controller.
//
// Each key's number is the TCA8418 key event code, `(col >> 1) * 10 + 1 + (col & 1) * 4 + row`
// for physical row 0..3 (top to bottom) and column 0..13 (left to right). That is the formula
// AREA512's own GPIO-matrix scanner uses to produce the same codes on the Cardputer v1.1
// (components/area512_hal/console/keyboard.cpp), and the legends below are what its
// `cardputer_lookup_key` / `cardputer_apply_shift` produce for each code.

export const ROWS = 4;
export const COLS = 14;

export const codeAt = (row, col) => (col >> 1) * 10 + 1 + (col & 1) * 4 + row;

// [base, shifted, fn-legend, kind]; kind: char | mod | special
const LAYOUT = [
  [['`', '~', 'esc'], ['1', '!'], ['2', '@'], ['3', '#'], ['4', '$'], ['5', '%'], ['6', '^'], ['7', '&'], ['8', '*'], ['9', '('], ['0', ')'], ['_', '-'], ['=', '+'], ['del', null, null, 'Backspace']],
  [['tab', null, null, 'Tab'], ['q'], ['w'], ['e'], ['r'], ['t'], ['y'], ['u'], ['i'], ['o'], ['p'], ['[', '{'], [']', '}'], ['\\', '|']],
  [['fn', null, null, 'Fn'], ['aa', null, null, 'Shift'], ['a'], ['s'], ['d'], ['f'], ['g'], ['h'], ['j'], ['k'], ['l'], [';', ':', '↑'], ["'", '"'], ['ok', null, null, 'Enter']],
  [['ctrl', null, null, 'Ctrl'], ['opt', null, null, 'Opt'], ['alt', null, null, 'Alt'], ['z'], ['x'], ['c'], ['v'], ['b'], ['n'], ['m'], [',', '<', '←'], ['.', '>', '↓'], ['/', '?', '→'], ['space', null, null, 'Space']],
];

export const MODIFIERS = ['Fn', 'Shift', 'Ctrl', 'Opt', 'Alt'];

/** Every key: {code, row, col, label, shifted, fnLabel, name} where name is set for non-characters. */
export const KEYS = LAYOUT.flatMap((row, r) => row.map(([label, shifted, fnLabel, name], c) => ({
  code: codeAt(r, c), row: r, col: c, label,
  shifted: shifted === undefined ? (/^[a-z]$/.test(label) ? label.toUpperCase() : null) : shifted,
  fnLabel: fnLabel || null,
  name: name || null,
  modifier: MODIFIERS.includes(name),
})));

export const KEY_BY_CODE = new Map(KEYS.map((k) => [k.code, k]));
export const KEY_BY_NAME = new Map(KEYS.filter((k) => k.name).map((k) => [k.name, k.code]));
export const CODE = Object.fromEntries(KEYS.filter((k) => k.name).map((k) => [k.name, k.code]));

// Character -> [code, needsShift]. Characters come from the firmware's legends.
const CHAR_TO_KEY = new Map();
for (const k of KEYS) {
  if (k.name) continue;
  CHAR_TO_KEY.set(k.label, [k.code, false]);
  if (k.shifted) CHAR_TO_KEY.set(k.shifted, [k.code, true]);
}

/**
 * Translate a browser KeyboardEvent into the Cardputer chord that types the same thing:
 * {code, shift, fn, ctrl, alt} or null. The firmware does its own shifting, so a host "!" is
 * Shift + the "1" key, and host "-" is Shift + the "_" key, as on the device.
 */
export function chordForEvent(ev) {
  const k = ev.key;
  const base = { shift: false, fn: false, ctrl: false, alt: false, opt: false };
  switch (k) {
    case 'Enter': return { ...base, code: CODE.Enter };
    case 'Backspace': case 'Delete': return { ...base, code: CODE.Backspace };
    case 'Tab': return { ...base, code: CODE.Tab, shift: ev.shiftKey };
    case 'Escape': return { ...base, code: codeAt(0, 0) };                // the firmware sends ESC for `
    case ' ': return { ...base, code: CODE.Space, ctrl: ev.ctrlKey };
    case 'ArrowUp': return { ...base, code: CHAR_TO_KEY.get(';')[0], fn: true };
    case 'ArrowDown': return { ...base, code: CHAR_TO_KEY.get('.')[0], fn: true };
    case 'ArrowLeft': return { ...base, code: CHAR_TO_KEY.get(',')[0], fn: true };
    case 'ArrowRight': return { ...base, code: CHAR_TO_KEY.get('/')[0], fn: true };
    case '`': return { ...base, code: codeAt(0, 0), fn: true };          // Fn+` types a backquote
    default: break;
  }
  if (ev.ctrlKey || ev.metaKey) {
    // Ctrl+letter: use the physical key so the shifted layout of the host does not matter.
    const m = /^Key([A-Z])$/.exec(ev.code || '');
    const ch = m ? m[1].toLowerCase() : (k.length === 1 ? k.toLowerCase() : null);
    const hit = ch && CHAR_TO_KEY.get(ch);
    return hit ? { ...base, code: hit[0], ctrl: true } : null;
  }
  if (k.length !== 1) return null;
  const hit = CHAR_TO_KEY.get(k);
  if (!hit) return null;
  return { ...base, code: hit[0], shift: hit[1], alt: ev.altKey };
}
