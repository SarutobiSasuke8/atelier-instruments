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
      if (status === 0xf8) {
        handlers.onClock?.(event);
        return;
      }
      if (status === 0xfa) {
        handlers.onStart?.(event);
        return;
      }
      if (status === 0xfb) {
        handlers.onContinue?.(event);
        return;
      }
      if (status === 0xfc) {
        handlers.onStop?.(event);
        return;
      }
      const command = status & 0xf0;
      const channel = status & 0x0f;
      if (command === 0x90 && data2 > 0) {
        handlers.onNote?.({ note: data1, velocity: data2 / 127, channel });
      } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        handlers.onNoteOff?.({ note: data1, velocity: data2 / 127, channel });
      } else if (command === 0xb0) {
        handlers.onCC?.({ controller: data1, value: data2 / 127, channel });
      } else if (command === 0xe0) {
        const raw = (data2 << 7) | data1;
        handlers.onPitchBend?.({ bend: (raw - 8192) / 8192, channel });
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

/** Equal temperament. MIDI note 69 is A4, 440 Hz. */
export function midiToHz(note) {
  return 440 * 2 ** ((Number(note) - 69) / 12);
}

/** Scientific pitch name. MIDI note 60 is C4. */
export function noteName(note) {
  const n = Math.round(Number(note));
  if (!Number.isFinite(n)) return "–";
  const pitch = ((n % 12) + 12) % 12;
  const octave = Math.floor(n / 12) - 1;
  return NOTE_NAMES[pitch] + octave;
}

/**
 * Look-ahead MIDI clock. Sends Start when started and Stop when stopped.
 * `send` receives a byte array. Bursts are capped so a tempo edit cannot flood the port.
 */
export function createMidiClockOut(send) {
  let timer = 0;
  let running = false;
  let next = 0;
  let audio = null;
  let bpmOf = () => 120;

  function loop() {
    if (!running || !audio) return;
    const bpm = Math.min(240, Math.max(40, Number(bpmOf()) || 120));
    const secondsPerClock = 60 / bpm / 24;
    const horizon = audio.currentTime + 0.08;
    let sent = 0;
    while (next < horizon && sent < 4) {
      send([0xf8]);
      next += secondsPerClock;
      sent += 1;
    }
    if (next < audio.currentTime) next = audio.currentTime + secondsPerClock;
    timer = setTimeout(loop, 20);
  }

  return {
    get running() {
      return running;
    },
    start(audioContext, getBpm) {
      if (running) this.stop();
      audio = audioContext;
      bpmOf = typeof getBpm === "function" ? getBpm : () => Number(getBpm) || 120;
      running = true;
      send([0xfa]);
      next = audio.currentTime + 0.002;
      loop();
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimeout(timer);
      send([0xfc]);
    },
  };
}

/**
 * Format-0 Standard MIDI file from absolute-tick note events.
 * events: { tick, type: "on"|"off", note, velocity }[]
 * @returns {Uint8Array}
 */
export function eventsToMidi({ tempo = 120, ticksPerQuarter = 96, name = "Atelier", events = [] } = {}) {
  const tpq = clampInt(ticksPerQuarter, 24, 960);
  const bpm = Math.min(400, Math.max(20, Number(tempo) || 120));
  const usPerQuarter = Math.round(60000000 / bpm);
  const sorted = events
    .map((event) => ({
      tick: Math.max(0, event.tick | 0),
      type: event.type === "off" ? "off" : "on",
      note: clampInt(event.note, 0, 127),
      velocity: clampInt(event.velocity ?? (event.type === "off" ? 0 : 96), 0, 127),
    }))
    .sort((a, b) => a.tick - b.tick || (a.type === "off" ? -1 : 1));

  const track = [];
  const nameBytes = ascii(name).slice(0, 64);
  pushBytes(track, [0x00, 0xff, 0x03, nameBytes.length, ...nameBytes]);
  pushBytes(track, [
    0x00,
    0xff,
    0x51,
    0x03,
    (usPerQuarter >> 16) & 0xff,
    (usPerQuarter >> 8) & 0xff,
    usPerQuarter & 0xff,
  ]);

  let lastTick = 0;
  for (const event of sorted) {
    pushBytes(track, [
      ...vlq(event.tick - lastTick),
      event.type === "off" ? 0x80 : 0x90,
      event.note,
      event.type === "off" ? 0 : event.velocity,
    ]);
    lastTick = event.tick;
  }
  pushBytes(track, [...vlq(0), 0xff, 0x2f, 0x00]);

  const header = new Uint8Array(14);
  header.set(ascii("MThd"), 0);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(4, 6, false);
  headerView.setUint16(8, 0, false);
  headerView.setUint16(10, 1, false);
  headerView.setUint16(12, tpq, false);

  const trackHead = new Uint8Array(8);
  trackHead.set(ascii("MTrk"), 0);
  new DataView(trackHead.buffer).setUint32(4, track.length, false);

  const out = new Uint8Array(header.length + trackHead.length + track.length);
  out.set(header, 0);
  out.set(trackHead, header.length);
  out.set(track, header.length + trackHead.length);
  return out;
}

function pushBytes(target, bytes) {
  for (const byte of bytes) target.push(byte & 0xff);
}

function vlq(value) {
  let n = value | 0;
  if (n < 0) n = 0;
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function ascii(text) {
  const out = [];
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    out.push(code >= 32 && code < 127 ? code : 0x3f);
  }
  return out;
}

function clampInt(n, min, max) {
  const value = Math.round(Number(n) || 0);
  return Math.min(max, Math.max(min, value));
}

export function midiOutputList(access) {
  if (!access?.outputs) return [];
  return [...access.outputs.values()];
}

export function sendMidi(output, bytes) {
  if (!output) return;
  try {
    output.send(bytes);
  } catch {
    /* device disconnected */
  }
}

export function silenceMidiOutput(output, channel = 0) {
  const status = 0xb0 | (channel & 0x0f);
  sendMidi(output, [status, 123, 0]);
  sendMidi(output, [status, 120, 0]);
}

function writeVarInt(out, value) {
  let v = value >>> 0;
  const stack = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    stack.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * Standard MIDI file (format 0) for note events in seconds.
 * events: { note, start, duration, velocity (1–127), channel }
 * @returns {Uint8Array}
 */
export function encodeMidiFile(events, options = {}) {
  const ticksPerBeat = options.ticksPerBeat ?? 480;
  const bpm = options.bpm ?? 120;
  const secondsToTicks = (seconds) =>
    Math.round(Math.max(0, seconds) * (bpm / 60) * ticksPerBeat);
  const microseconds = Math.max(1, Math.round(60000000 / bpm));
  const name = [...new TextEncoder().encode(String(options.trackName ?? "Atelier"))];
  const nameLength = [];
  writeVarInt(nameLength, name.length);
  const timed = [
    {
      tick: 0,
      order: 0,
      bytes: [0xff, 0x51, 0x03, (microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff],
    },
    { tick: 0, order: 1, bytes: [0xff, 0x03, ...nameLength, ...name] },
  ];
  for (const event of events) {
    const channel = (event.channel ?? 0) & 0x0f;
    const note = Math.max(0, Math.min(127, Math.round(event.note)));
    const velocity = Math.max(1, Math.min(127, Math.round(event.velocity ?? 96)));
    const on = secondsToTicks(event.start ?? 0);
    const off = Math.max(on + 1, secondsToTicks((event.start ?? 0) + (event.duration ?? 0.25)));
    timed.push({ tick: off, order: 2, bytes: [0x80 | channel, note, 0] });
    timed.push({ tick: on, order: 3, bytes: [0x90 | channel, note, velocity] });
  }
  timed.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track = [];
  let lastTick = 0;
  for (const item of timed) {
    writeVarInt(track, item.tick - lastTick);
    for (const byte of item.bytes) track.push(byte);
    lastTick = item.tick;
  }
  writeVarInt(track, 0);
  track.push(0xff, 0x2f, 0x00);
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (ticksPerBeat >> 8) & 0xff,
    ticksPerBeat & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    ...u32(track.length),
    ...track,
  ]);
}

// Arpeggiator Lab helpers (name parsing, beat-timed SMF, same-origin note bus).
const FLATS = { DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#" };

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

function clampIntOr(value, min, max, fallback) {
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
  const bpm = clampIntOr(spec.bpm ?? 120, 20, 400, 120);
  const ppq = clampIntOr(spec.ppq ?? 480, 24, 960, 480);
  const defaultChannel = clampIntOr(spec.channel ?? 0, 0, 15, 0);
  const timed = [];
  for (const event of events) {
    const note = clampIntOr(event.note, 0, 127, -1);
    if (note < 0) continue;
    const channel = clampIntOr(event.channel ?? defaultChannel, 0, 15, defaultChannel);
    const velocity = clampIntOr(event.velocity ?? 100, 1, 127, 100);
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
