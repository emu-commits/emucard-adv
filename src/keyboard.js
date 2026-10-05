// The on-screen Cardputer keyboard. Keys send TCA8418 codes through `send(code, down)`.
//
// Modifiers behave as on the device when held (multi-touch works), and a modifier tapped on its
// own latches until the next key is released, so one finger can type Fn+; or ctrl+c.
import { KEYS } from './keymap.js';

export function createKeyboard(root, send) {
  const held = new Map();         // pointerId -> key
  const latched = new Set();      // modifier codes latched by a lone tap
  const els = new Map();
  let usedWhileHeld = new Set();  // modifiers held while another key went down
  const unlatching = new Set();   // latched modifiers tapped again: the release does nothing

  for (const k of KEYS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'key' + (k.modifier ? ' mod' : k.name ? ' special' : '');
    el.dataset.code = k.code;
    if (k.name) el.dataset.name = k.name;
    el.setAttribute('aria-label', k.name || k.label);
    el.innerHTML = '';
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
    els.set(k.code, el);
    root.append(el);
  }

  const keyOf = (code) => KEYS.find((k) => k.code === code);
  const setDown = (code, on) => els.get(code)?.classList.toggle('down', on);

  function press(k) {
    if (k.modifier) {
      if (latched.has(k.code)) {
        latched.delete(k.code);
        els.get(k.code).classList.remove('latched');
        send(k.code, false);
        unlatching.add(k.code);
        setDown(k.code, true);
        return;
      }
      usedWhileHeld.delete(k.code);
      send(k.code, true);
      setDown(k.code, true);
      return;
    }
    for (const h of held.values()) if (h.modifier) usedWhileHeld.add(h.code);
    send(k.code, true);
    setDown(k.code, true);
  }

  function release(k) {
    setDown(k.code, false);
    if (unlatching.delete(k.code)) return;
    if (k.modifier) {
      // A lone tap latches the modifier for the next key; a modifier used as a chord releases.
      if (!usedWhileHeld.has(k.code)) {
        latched.add(k.code);
        els.get(k.code).classList.add('latched');
        return;                                   // keep it down on the device
      }
      usedWhileHeld.delete(k.code);
      send(k.code, false);
      return;
    }
    send(k.code, false);
    for (const code of latched) { send(code, false); els.get(code).classList.remove('latched'); }
    latched.clear();
  }

  root.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('.key');
    if (!el) return;
    ev.preventDefault();
    el.setPointerCapture?.(ev.pointerId);
    const k = keyOf(+el.dataset.code);
    held.set(ev.pointerId, k);
    press(k);
  });
  const end = (ev) => {
    const k = held.get(ev.pointerId);
    if (!k) return;
    held.delete(ev.pointerId);
    release(k);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('contextmenu', (ev) => ev.preventDefault());

  return {
    /** Show a key as pressed (physical keyboard feedback). */
    show(code, on) { setDown(code, on); },
    /** Release everything, e.g. when the page loses focus. */
    reset() {
      for (const k of held.values()) send(k.code, false);
      for (const code of latched) send(code, false);
      held.clear(); latched.clear(); usedWhileHeld.clear();
      for (const el of els.values()) el.classList.remove('down', 'latched');
    },
  };
}
