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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

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
