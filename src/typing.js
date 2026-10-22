// Touch typing: the phone's own keyboard, with a bar for the keys it lacks.
//
// A transparent text field lies over the Cardputer screen, so tapping the screen (or the
// keyboard button beside it) brings up the system keyboard. Keys that arrive as KeyboardEvents
// are handled by the page like a physical keyboard's; text that only arrives as input (Android
// IMEs, paste, autocorrect) is typed here one character at a time, and the field never keeps
// any of it. While the field has focus, a bar with esc, tab, the modifiers and the arrow keys
// rides on top of the system keyboard. The Cardputer keyboard stays where it is, for when the
// system keyboard is put away.
import { CODE, ARROW, codeAt, chordForChar, chordCodes } from './keymap.js';

const SENTINEL = '​';    // lets Backspace reach us in an otherwise empty field
const GAP_MS = 40;            // between queued characters, so a paste does not flood the keypad

const BAR_KEYS = [
  { code: codeAt(0, 0), label: 'esc', name: 'Escape', area: '1 / 1' },
  { code: CODE.Tab, label: 'tab', name: 'Tab', area: '1 / 2' },
  { code: CODE.Fn, label: 'fn', name: 'Fn', modifier: true, area: '1 / 3' },
  { code: CODE.Ctrl, label: 'ctrl', name: 'Ctrl', modifier: true, area: '2 / 1' },
  { code: CODE.Opt, label: 'opt', name: 'Opt', modifier: true, area: '2 / 2' },
  { code: CODE.Alt, label: 'alt', name: 'Alt', modifier: true, area: '2 / 3' },
  { code: ARROW.Up, with: [CODE.Fn], label: '↑', name: 'Up', cls: 'arrow', area: '1 / 6' },
  { code: ARROW.Left, with: [CODE.Fn], label: '←', name: 'Left', cls: 'arrow', area: '2 / 5' },
  { code: ARROW.Down, with: [CODE.Fn], label: '↓', name: 'Down', cls: 'arrow', area: '2 / 6' },
  { code: ARROW.Right, with: [CODE.Fn], label: '→', name: 'Right', cls: 'arrow', area: '2 / 7' },
];

export function createTyping({ input, bar, button, keyboard, onBlur }) {
  keyboard.mount(bar, BAR_KEYS);
  const hide = bar.querySelector('.hide');

  // ---- typing queued characters ----
  const queue = [];
  let busy = false;
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const codes = chordCodes(queue.shift());
    for (const c of codes) keyboard.hold(c);
    for (const c of codes.slice().reverse()) keyboard.drop(c);
    keyboard.typed();
    setTimeout(() => { busy = false; pump(); }, GAP_MS);
  }
  /** Tap a chord: press and release it, after anything already queued. */
  function type(chord) {
    if (chord) queue.push(chord);
    pump();
  }
  const typeText = (text) => {
    for (const ch of (text || '').replace(/\r\n?/g, '\n').replace(/…/g, '...')) type(chordForChar(ch));
  };

  // ---- the field ----
  const clear = () => { input.value = SENTINEL; input.setSelectionRange(1, 1); };
  input.addEventListener('beforeinput', (ev) => {
    if (ev.isComposing) return;                   // finished words arrive with compositionend
    ev.preventDefault();
    const t = ev.inputType;
    if (t.startsWith('insert') && t !== 'insertLineBreak' && t !== 'insertParagraph') {
      typeText(ev.data ?? ev.dataTransfer?.getData('text/plain'));
    } else if (t === 'insertLineBreak' || t === 'insertParagraph') type({ code: CODE.Enter });
    else if (t === 'deleteContentBackward' || t === 'deleteWordBackward') type({ code: CODE.Backspace });
  });
  input.addEventListener('compositionend', (ev) => { typeText(ev.data); clear(); });
  input.addEventListener('input', (ev) => { if (!ev.isComposing) clear(); });

  // ---- the bar, riding on top of the system keyboard ----
  const vv = window.visualViewport;
  function place() {
    if (bar.hidden) return;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    bar.style.transform = `translateY(${Math.min(0, bottom - document.documentElement.clientHeight)}px)`;
  }
  vv?.addEventListener('resize', place);
  vv?.addEventListener('scroll', place);

  input.addEventListener('focus', () => {
    clear();
    bar.hidden = false;
    document.body.classList.add('typing');
    place();
  });
  input.addEventListener('blur', () => {
    bar.hidden = true;
    document.body.classList.remove('typing');
    onBlur?.();
  });

  // Touches on the bar must not take focus from the field, or the system keyboard would close.
  bar.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false });
  bar.addEventListener('mousedown', (ev) => ev.preventDefault());
  hide.addEventListener('pointerup', () => input.blur());

  // The keyboard button toggles the system keyboard. Focus is decided at pointerdown, before the
  // tap itself can move it.
  let wasTyping = false;
  button.addEventListener('pointerdown', () => { wasTyping = document.activeElement === input; });
  button.addEventListener('click', () => { if (wasTyping) input.blur(); else input.focus(); });

  return { type, active: () => document.activeElement === input };
}
