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
