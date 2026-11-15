// Agent descriptor for the Chord Pad Player. See agent/README.md.
import { bool, list, num, oneOf, obj } from "../../shared/params.js";
import { CHORD_TYPES, KEYS, PAD_COUNT, SCALE_IDS, SOUNDS, planProgression, renderProgression } from "./engine.js";

export default {
  id: "chord-pads",
  name: "Chord Pad Player",
  role: "generator",
  summary: "Voices a chord progression in a key and scale and renders it with a pad, piano-like, pluck or supersaw sound. Each chord is a pad (0 to 15), a scale degree with an octave, or explicit MIDI notes. Times are in beats. Also returns the voiced notes for an LMMS pattern. The render is normalised to a -1 dBFS peak, so velocity shapes the balance inside one render only.",
  params: obj({
    key: oneOf(KEYS, "C"),
    scale: oneOf(SCALE_IDS, "major"),
    chordType: oneOf(CHORD_TYPES, "triad"),
    inversion: num(0, 3, { default: 0, integer: true }),
    spread: num(0, 3, { default: 0, integer: true, description: "0 close, 1 to 3 progressively wider voicings." }),
    voiceLeading: bool(false, "Move each chord to the nearest voicing of the last one."),
    strum: obj({
      enabled: bool(true),
      speedMs: num(0, 200, { default: 0, description: "Delay between strummed notes. 0 plays the chord at once." }),
      direction: oneOf(["up", "down"], "up"),
    }),
    sound: oneOf(SOUNDS, "pad"),
    bpm: num(40, 240, { default: 120 }),
    seed: num(0, 4294967295, { default: 1, integer: true }),
    progression: list(
      obj({
        pad: num(0, PAD_COUNT - 1, { optional: true, integer: true, description: "Pads 0 to 6 are degrees 1 to 7 in octave 4, 7 is the tonic an octave up, 8 to 14 are degrees in octave 3, 15 is the tonic in octave 2." }),
        degree: num(0, 6, { optional: true, integer: true, description: "Scale degree from 0. Use with octave." }),
        octave: num(1, 7, { optional: true, integer: true }),
        notes: list(num(0, 127, { integer: true }), { min: 1, max: 12, optional: true, description: "Explicit MIDI notes instead of a pad or degree." }),
        chordType: oneOf(CHORD_TYPES, undefined, "Override for this chord."),
        inversion: num(0, 3, { optional: true, integer: true }),
        spread: num(0, 3, { optional: true, integer: true }),
        startBeat: num(0, 1024, { required: true }),
        durationBeats: num(0.0625, 256, { required: true }),
        velocity: num(0, 1, { default: 0.8 }),
      }),
      { min: 1, max: 256, required: true },
    ),
  }),
  example: {
    key: "A",
    scale: "naturalMinor",
    chordType: "7th",
    sound: "pad",
    bpm: 90,
    progression: [
      { pad: 0, startBeat: 0, durationBeats: 4 },
      { pad: 5, startBeat: 4, durationBeats: 4 },
      { pad: 2, startBeat: 8, durationBeats: 4 },
      { pad: 6, startBeat: 12, durationBeats: 4 },
    ],
  },
  presets: (file) => {
    const { name, genre, loop, ...rest } = file;
    return [{ name, params: rest }];
  },
  check(params) {
    for (const [i, chord] of params.progression.entries()) {
      const ways = [chord.pad !== undefined, chord.degree !== undefined, chord.notes !== undefined].filter(Boolean).length;
      if (ways !== 1) return `progression[${i}] needs exactly one of pad, degree or notes.`;
    }
    return null;
  },
  render(params, { sampleRate }) {
    const out = renderProgression(params.progression, { ...params, sampleRate });
    return { sampleRate: out.sampleRate, channels: [out.left, out.right], notes: this.notes(params) };
  },
  notes(params) {
    const plan = planProgression(params.progression, params);
    const perBeat = params.bpm / 60;
    const notes = plan.midiEvents.map((e) => ({
      midi: e.note,
      start: e.start * perBeat,
      duration: e.duration * perBeat,
      velocity: e.velocity / 127,
    }));
    const lengthBeats = params.progression.reduce((end, c) => Math.max(end, c.startBeat + c.durationBeats), 0);
    return { bpm: params.bpm, lengthBeats, notes };
  },
};
