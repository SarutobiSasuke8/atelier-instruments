/* Atelier Instruments — MIT License.
   Chromatic computer-key map for the on-screen keyboard. No DOM writes. */

export const KEY_OFFSETS = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
};

export function textField(target) {
  if (!target || !target.tagName) return false;
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;
  return target.tagName === "INPUT" && target.getAttribute("type") !== "range";
}

/** Semitone offset from the keyboard root, or null when the key should be ignored. */
export function offsetFromKey(event) {
  if (!event || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (textField(event.target)) return null;
  const key = String(event.key || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(KEY_OFFSETS, key) ? KEY_OFFSETS[key] : null;
}
