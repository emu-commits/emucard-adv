// The on-screen keyboards. Keys send TCA8418 codes through `send(code, down)`.
//
// Modifiers behave as on the device when held (multi-touch works), and a modifier tapped on its
// own latches until the next key is released, so one finger can type Fn+; or ctrl+c.
// Every press is counted per code, so the Cardputer keyboard, the touch typing bar and a physical
// keyboard can hold the same key without releasing it for each other.
import { KEYS } from './keymap.js';

export function createKeyboard(root, send) {
  const count = new Map();        // code -> presses holding it down
  const els = new Map();          // code -> buttons showing it
  const keyOf = new WeakMap();    // button -> key
  const buttons = [];
  const held = new Map();         // pointerId -> [key, button]
  const latched = new Set();      // modifier codes latched by a lone tap
  const usedWhileHeld = new Set();  // modifiers held while another key went down
  const unlatching = new Set();   // latched modifiers tapped again: the release does nothing

  const show = (code, cls, on) => { for (const el of els.get(code) || []) el.classList.toggle(cls, on); };

  function hold(code) {
    const n = count.get(code) || 0;
    count.set(code, n + 1);
    if (!n) { send(code, true); show(code, 'down', true); }
  }

  function drop(code) {
    const n = count.get(code) || 0;
    if (n > 1) { count.set(code, n - 1); return; }
    if (!n) return;
    count.delete(code);
    send(code, false);
    show(code, 'down', false);
  }

  /** A key went up: held modifiers were used for it, and latched ones are spent. */
  function typed() {
    for (const [h] of held.values()) if (h.modifier) usedWhileHeld.add(h.code);
    for (const code of latched) { show(code, 'latched', false); drop(code); }
    latched.clear();
  }

  function press(k) {
    if (k.modifier) {
      if (latched.has(k.code)) {
        latched.delete(k.code);
        show(k.code, 'latched', false);
        drop(k.code);
        unlatching.add(k.code);
        return;
      }
      usedWhileHeld.delete(k.code);
      hold(k.code);
      return;
    }
    for (const [h] of held.values()) if (h.modifier) usedWhileHeld.add(h.code);
    for (const c of k.with || []) hold(c);
    hold(k.code);
  }

  function release(k) {
    if (unlatching.delete(k.code)) return;
    if (k.modifier) {
      // A lone tap latches the modifier for the next key; a modifier used as a chord releases.
      if (!usedWhileHeld.has(k.code)) {
        latched.add(k.code);
        show(k.code, 'down', false);
        show(k.code, 'latched', true);
        return;                                   // keep it down on the device
      }
      usedWhileHeld.delete(k.code);
      drop(k.code);
      return;
    }
    drop(k.code);
    for (const c of [...(k.with || [])].reverse()) drop(c);
    typed();
  }

  /**
   * Add buttons for `keys` to `container`. A key is {code, label, name?, shifted?, fnLabel?,
   * modifier?}, plus `with` (codes held along with it, as Fn for the arrows), `cls` and `area`
   * (its CSS grid-area).
   */
  function mount(container, keys) {
    for (const k of keys) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'key' + (k.modifier ? ' mod' : k.name ? ' special' : '') + (k.cls ? ' ' + k.cls : '');
      el.dataset.code = k.code;
      if (k.name) el.dataset.name = k.name;
      if (k.area) el.style.gridArea = k.area;
      el.setAttribute('aria-label', k.name || k.label);
      const main = document.createElement('span');
      main.textContent = k.label;
      el.append(main);
      if (k.shifted && !/^[A-Z]$/.test(k.shifted)) {
        const s = document.createElement('span');
        s.className = 'shift';
        s.textContent = k.shifted;
        el.append(s);
      }
      if (k.fnLabel) {
        const f = document.createElement('span');
        f.className = 'fn';
        f.textContent = k.fnLabel;
        el.append(f);
      }
      keyOf.set(el, k);
      buttons.push(el);
      if (!k.with) { if (!els.has(k.code)) els.set(k.code, []); els.get(k.code).push(el); }
      container.append(el);
    }

    container.addEventListener('pointerdown', (ev) => {
      const el = ev.target.closest('.key');
      const k = el && keyOf.get(el);
      if (!k) return;
      ev.preventDefault();
      el.setPointerCapture?.(ev.pointerId);
      held.set(ev.pointerId, [k, el]);
      el.classList.add('down');
      press(k);
    });
    const end = (ev) => {
      const h = held.get(ev.pointerId);
      if (!h) return;
      held.delete(ev.pointerId);
      h[1].classList.remove('down');
      release(h[0]);
    };
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
    container.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  mount(root, KEYS);

  return {
    mount,
    /** Press or release a key for another source, such as a physical keyboard. */
    hold, drop, typed,
    /** Release everything, e.g. when the page loses focus. */
    reset() {
      for (const code of count.keys()) send(code, false);
      count.clear(); held.clear(); latched.clear(); usedWhileHeld.clear(); unlatching.clear();
      for (const el of buttons) el.classList.remove('down', 'latched');
    },
  };
}
