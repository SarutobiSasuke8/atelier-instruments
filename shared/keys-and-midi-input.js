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

/**
 * Key-up partner for bindKeys. Same text-field guard, including range inputs.
 * @param {Record<string, (event: KeyboardEvent) => void>} bindings
 * @param {EventTarget} [target]
 * @returns {() => void}
 */
export function bindKeyReleases(bindings, target = globalThis) {
  const onKey = (event) => {
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
  target.addEventListener("keyup", onKey);
  return () => target.removeEventListener("keyup", onKey);
}

const NOTE_CODES = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
};

/**
 * Performance keyboard: note on/off for the letter row, Z/X octave, space transport.
 * Text fields are ignored. Buttons keep their own space activation.
 */
export function bindKeyboardNotes(handlers, target = globalThis) {
  const held = new Set();

  function typing(event) {
    const el = event.target;
    if (!el || !TEXT_FIELDS.has(el.tagName)) return false;
    const type = el.getAttribute?.("type");
    return type !== "range";
  }

  function down(event) {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || typing(event)) return;
    if (event.code === "Space") {
      if (event.target?.closest?.("button, a")) return;
      event.preventDefault();
      handlers.onTransport?.();
      return;
    }
    if (event.code === "KeyZ" || event.code === "KeyX") {
      event.preventDefault();
      handlers.onOctave?.(event.code === "KeyZ" ? -1 : 1);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(NOTE_CODES, event.code)) return;
    event.preventDefault();
    if (held.has(event.code)) return;
    held.add(event.code);
    handlers.onNoteOn?.(NOTE_CODES[event.code], event);
  }

  function up(event) {
    if (!held.has(event.code)) return;
    held.delete(event.code);
    handlers.onNoteOff?.(NOTE_CODES[event.code], event);
  }

  function blur() {
    for (const code of held) handlers.onNoteOff?.(NOTE_CODES[code]);
    held.clear();
  }

  target.addEventListener("keydown", down);
  target.addEventListener("keyup", up);
  globalThis.addEventListener?.("blur", blur);
  return () => {
    target.removeEventListener("keydown", down);
    target.removeEventListener("keyup", up);
    globalThis.removeEventListener?.("blur", blur);
    blur();
  };
}

/**
 * Keyboard holds. `holds` maps KeyboardEvent.code to { down, up }.
 * Text fields are ignored; range inputs are not. Returns an unbind function.
 * @param {Record<string, { down?: (event: KeyboardEvent) => void, up?: (event: KeyboardEvent) => void }>} holds
 * @param {EventTarget} [target]
 */
export function bindKeyHolds(holds, target = globalThis) {
  const held = new Set();
  const typing = (event) => {
    const el = event.target;
    if (!el || !TEXT_FIELDS.has(el.tagName)) return false;
    return el.getAttribute?.("type") !== "range";
  };
  const onDown = (event) => {
    if (event.repeat || typing(event)) return;
    if (event.code === "Space" && event.target && (event.target.tagName === "BUTTON" || event.target.tagName === "A")) {
      return;
    }
    const spec = holds[event.code];
    if (!spec || held.has(event.code)) return;
    held.add(event.code);
    event.preventDefault();
    spec.down?.(event);
  };
  const onUp = (event) => {
    if (!held.has(event.code)) return;
    held.delete(event.code);
    holds[event.code]?.up?.(event);
  };
  const release = () => {
    for (const code of [...held]) {
      held.delete(code);
      holds[code]?.up?.();
    }
  };
  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  globalThis.addEventListener?.("blur", release);
  return () => {
    target.removeEventListener("keydown", onDown);
    target.removeEventListener("keyup", onUp);
    globalThis.removeEventListener?.("blur", release);
  };
}
