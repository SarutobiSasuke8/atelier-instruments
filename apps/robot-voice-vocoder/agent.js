// Agent descriptor for the Robot Voice Vocoder. See agent/README.md.
import { bool, list, num, oneOf, obj } from "../../shared/params.js";
import { ARP_PATTERNS, BAND_CHOICES, MODE_IDS, WAVE_IDS, defaultPreset, renderVocoded } from "./engine.js";

const d = defaultPreset();

export default {
  id: "robot-voice-vocoder",
  name: "Robot Voice Vocoder",
  role: "processor",
  summary: "Vocodes a voice recording (the input) with a synth carrier played by notes in seconds. Modes set a character: robot, choir, talkbox, whisper, monotone. Fields you give override the mode. Output is mono and at most 30 seconds.",
  params: obj({
    mode: oneOf(MODE_IDS, "robot"),
    notes: list(
      obj({
        midi: num(0, 127, { required: true, integer: true }),
        start: num(0, 30, { required: true, description: "Seconds." }),
        duration: num(0.01, 30, { required: true, description: "Seconds." }),
        velocity: num(0, 1, { optional: true, description: "Defaults to 0.85." }),
      }),
      { max: 1024, default: [], description: "Carrier notes. Leave empty with monotone true to hold root." },
    ),
    duration: num(0.05, 30, { optional: true, description: "Seconds. Defaults to the longer of the voice and the notes." }),
    loop: bool(false, "Loop the voice under longer notes."),
    seed: num(0, 4294967295, { default: 1, integer: true }),
    bands: oneOf(BAND_CHOICES, undefined),
    formant: num(-12, 12, { optional: true, description: "Semitones." }),
    q: num(0.8, 14, { optional: true }),
    attack: num(0.001, 0.4, { optional: true }),
    release: num(0.008, 0.8, { optional: true }),
    sibilance: num(0, 1, { optional: true }),
    noiseBlend: num(0, 1, { optional: true }),
    dryWet: num(0, 1, { optional: true }),
    wave: oneOf(WAVE_IDS, undefined),
    detune: num(0, 50, { optional: true }),
    unison: num(1, 8, { optional: true, integer: true }),
    hold: bool(undefined),
    monotone: bool(undefined),
    root: num(24, 84, { optional: true, integer: true, description: "MIDI note for monotone." }),
    chorus: num(0, 1, { optional: true }),
    delayMix: num(0, 1, { optional: true }),
    delayTime: num(0.04, 1.2, { optional: true }),
    delayFeedback: num(0, 0.88, { optional: true }),
    reverb: num(0, 1, { optional: true }),
    gain: num(0, 1.5, { optional: true }),
    inputGain: num(0, 2, { optional: true }),
    arp: obj(
      {
        enabled: bool(d.arp.enabled),
        rate: num(0.5, 24, { default: d.arp.rate }),
        pattern: oneOf(ARP_PATTERNS, d.arp.pattern),
        octaves: num(1, 3, { default: d.arp.octaves, integer: true }),
        gate: num(0.08, 0.98, { default: d.arp.gate }),
      },
      { optional: true },
    ),
  }),
  example: { mode: "robot", notes: [{ midi: 48, start: 0, duration: 2 }, { midi: 55, start: 0, duration: 2 }] },
  presets: (file) => {
    const { name, ...params } = file;
    return [{ name, params }];
  },
  check(params) {
    if (!params.notes.length && !params.monotone && params.mode !== "monotone") {
      return "Give notes, or set monotone true or mode monotone to hold the root note.";
    }
    return null;
  },
  process(audio, params) {
    const { notes, duration, loop, seed, ...preset } = params;
    const mono = new Float32Array(audio.channels[0].length);
    for (const channel of audio.channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.channels.length;
    const out = renderVocoded(
      { samples: mono, sampleRate: audio.sampleRate },
      notes.map((n) => ({ note: n.midi, start: n.start, duration: n.duration, velocity: n.velocity })),
      preset,
      { duration, loop, seed, sampleRate: audio.sampleRate },
    );
    return { sampleRate: out.sampleRate, channels: [out.samples] };
  },
};
