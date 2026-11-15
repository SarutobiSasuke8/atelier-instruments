// Atelier Instruments — MIT License
// Thin Web MIDI helpers. No libraries.

export function supportsMidi() {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

/**
 * Request MIDI access. Must be called from a user gesture in most browsers.
 * @returns {Promise<MIDIAccess>}
 */
export function openMidi() {
  if (!supportsMidi()) {
    throw new Error("Web MIDI is not available in this browser");
  }
  return navigator.requestMIDIAccess({ sysex: false });
}

function describeAccess(access) {
  const inputs = [];
  for (const input of access.inputs.values()) inputs.push(input.name || "MIDI input");
  return {
    available: true,
    inputs,
    message: inputs.length ? inputs.join(", ") : "MIDI on, no inputs",
  };
}

/**
 * Listen to note and CC messages from every current and future input.
 * @returns {() => void} stop
 */
export function listenMidi(access, handlers = {}) {
  const attach = (input) => {
    input.onmidimessage = (event) => {
      const [status = 0, data1 = 0, data2 = 0] = event.data;
      const command = status & 0xf0;
      const channel = status & 0x0f;
      if (command === 0x90 && data2 > 0) {
        handlers.onNote?.({ note: data1, velocity: data2 / 127, channel });
      } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        handlers.onNoteOff?.({ note: data1, velocity: data2 / 127, channel });
      } else if (command === 0xb0) {
        handlers.onCC?.({ controller: data1, value: data2 / 127, channel });
      }
    };
  };

  for (const input of access.inputs.values()) attach(input);
  access.onstatechange = () => {
    for (const input of access.inputs.values()) attach(input);
    handlers.onStatus?.(describeAccess(access));
  };
  handlers.onStatus?.(describeAccess(access));

  return () => {
    access.onstatechange = null;
    for (const input of access.inputs.values()) input.onmidimessage = null;
  };
}

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = { DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#" };

/** Middle C (MIDI 60) is C4. */
export function noteName(midi) {
  const n = Math.round(Number(midi));
  if (!Number.isFinite(n)) return "";
  const pc = ((n % 12) + 12) % 12;
  const oct = Math.floor(n / 12) - 1;
  return NOTE_NAMES[pc] + oct;
}

/** Parse "C4", "C#4", or "Db3". Returns null when the name is invalid. */
export function midiFromName(name) {
  if (typeof name !== "string") return null;
  const match = name.trim().toUpperCase().match(/^([A-G])([B#]?)(-?\d+)$/);
  if (!match) return null;
  let pc = match[1] + match[2];
  if (FLATS[pc]) pc = FLATS[pc];
  const index = NOTE_NAMES.indexOf(pc);
  if (index < 0) return null;
  const midi = (Number(match[3]) + 1) * 12 + index;
  if (midi < 0 || midi > 127) return null;
  return midi;
}

function varLen(value) {
  let v = Math.max(0, value | 0);
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Format 0 Standard MIDI File. Event times are quarter-note beats.
 * Channel is 0–15. Existing Web MIDI helpers above are unchanged.
 * @param {{events?: {note:number,start:number,duration:number,velocity?:number,channel?:number}[], bpm?:number, ppq?:number, channel?:number, name?:string}} spec
 * @returns {Uint8Array}
 */
export function encodeMidi(spec = {}) {
  const events = Array.isArray(spec.events) ? spec.events : [];
  const bpm = clampInt(spec.bpm ?? 120, 20, 400, 120);
  const ppq = clampInt(spec.ppq ?? 480, 24, 960, 480);
  const defaultChannel = clampInt(spec.channel ?? 0, 0, 15, 0);
  const timed = [];
  for (const event of events) {
    const note = clampInt(event.note, 0, 127, -1);
    if (note < 0) continue;
    const channel = clampInt(event.channel ?? defaultChannel, 0, 15, defaultChannel);
    const velocity = clampInt(event.velocity ?? 100, 1, 127, 100);
    const onTick = Math.max(0, Math.round(Number(event.start) * ppq) || 0);
    const durTicks = Math.max(1, Math.round(Number(event.duration) * ppq) || 1);
    timed.push({ tick: onTick, pri: 1, data: [0x90 | channel, note, velocity] });
    timed.push({ tick: onTick + durTicks, pri: 0, data: [0x80 | channel, note, 0] });
  }
  timed.sort((a, b) => a.tick - b.tick || a.pri - b.pri);

  const track = [];
  const push = (tick, data, cursor) => {
    track.push(...varLen(tick - cursor), ...data);
    return tick;
  };
  let cursor = 0;
  const mpqn = Math.round(60000000 / bpm);
  cursor = push(0, [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff], cursor);
  const label = String(spec.name || "Atelier").replace(/[^\x20-\x7e]/g, "").slice(0, 48);
  if (label) {
    const chars = [...label].map((ch) => ch.charCodeAt(0));
    cursor = push(0, [0xff, 0x03, chars.length, ...chars], cursor);
  }
  for (const item of timed) cursor = push(item.tick, item.data, cursor);
  track.push(...varLen(0), 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, (ppq >> 8) & 0xff, ppq & 0xff];
  const length = track.length;
  const trackHead = [0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
  return Uint8Array.from([...header, ...trackHead, ...track]);
}

/** Same-origin note bus so one atelier page can play another. */
export const ATELIER_BUS = "atelier-midi";

export function openAtelierBus() {
  if (typeof BroadcastChannel === "undefined") {
    return { post() {}, subscribe() { return () => {}; }, close() {} };
  }
  const channel = new BroadcastChannel(ATELIER_BUS);
  const listeners = new Set();
  channel.onmessage = (event) => {
    for (const listener of listeners) listener(event.data);
  };
  return {
    post(message) { channel.postMessage(message); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() { channel.close(); },
  };
}
