// Atelier Instruments — MIT License
// Computer-keyboard bindings and Web MIDI performance input.

import { openMidi, listenMidi, supportsMidi } from "./midi.js";

const TEXT_FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Bind KeyboardEvent.code values to handlers.
 * Range inputs still receive focus, but keys are not swallowed by text fields.
 * @param {Record<string, (event: KeyboardEvent) => void>} bindings
 * @param {EventTarget} [target]
 * @returns {() => void}
 */
export function bindKeys(bindings, target = globalThis) {
  const onKey = (event) => {
    if (event.repeat) return;
    const el = event.target;
    if (el && TEXT_FIELDS.has(el.tagName)) {
      const type = el.getAttribute?.("type");
      if (type !== "range") return;
    }
    const fn = bindings[event.code];
    if (!fn) return;
    event.preventDefault();
    fn(event);
  };
  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}

/**
 * Hold-style keys: keydown starts a pad, keyup releases it.
 * @param {Record<string, number>} codeToId
 * @param {{ onDown: Function, onUp: Function }} handlers
 * @param {EventTarget} [target]
 */
export function bindHeldKeys(codeToId, handlers, target = globalThis) {
  const held = new Set();
  const typing = (event) => {
    const el = event.target;
    if (!el || !TEXT_FIELDS.has(el.tagName)) return false;
    return el.getAttribute?.("type") !== "range";
  };
  const onDown = (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || typing(event)) return;
    const id = codeToId[event.code];
    if (id == null || held.has(event.code)) return;
    held.add(event.code);
    event.preventDefault();
    handlers.onDown(id, event);
  };
  const onUp = (event) => {
    const id = codeToId[event.code];
    if (id == null || !held.has(event.code)) return;
    held.delete(event.code);
    event.preventDefault();
    handlers.onUp(id, event);
  };
  const onBlur = () => {
    for (const code of held) {
      const id = codeToId[code];
      if (id != null) handlers.onUp(id);
    }
    held.clear();
  };
  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onDown);
    target.removeEventListener("keyup", onUp);
    target.removeEventListener("blur", onBlur);
  };
}

/**
 * Open Web MIDI from a user gesture and forward notes and CCs.
 * Resolves even when MIDI is missing, so the UI can show a status.
 * @returns {Promise<() => void>}
 */
export async function bindMidiPerformance(handlers = {}) {
  if (!supportsMidi()) {
    handlers.onStatus?.({
      available: false,
      inputs: [],
      message: "Web MIDI unavailable",
    });
    return () => {};
  }
  try {
    const access = await openMidi();
    handlers.onAccess?.(access);
    return listenMidi(access, handlers);
  } catch (error) {
    handlers.onStatus?.({
      available: false,
      inputs: [],
      message: error?.message || "MIDI permission denied",
    });
    return () => {};
  }
}

export { supportsMidi };
