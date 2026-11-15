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
