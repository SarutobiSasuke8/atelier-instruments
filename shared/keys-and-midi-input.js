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
