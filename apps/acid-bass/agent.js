// Agent descriptor for the Acid Bass Box. See agent/README.md.
import { bool, list, num, oneOf, obj } from "../../shared/params.js";
import { flattenPattern, renderAcidPattern, resolveParams } from "./engine.js";

const unit = (value, description) => num(0, 1, { default: value, description });
const step = obj({
  gate: bool(false, "True plays the step."),
  note: num(0, 11, { default: 0, integer: true, description: "Pitch class above rootMidi, 0 to 11." }),
  octave: num(0, 2, { default: 1, integer: true }),
  accent: bool(false),
  slide: bool(false, "Glide into the next gated step."),
});
const steps = (description) => list(step, { min: 1, max: 64, optional: true, description });

export default {
  id: "acid-bass",
  name: "Acid Bass Box",
  role: "generator",
  summary: "Mono acid bassline: saw or square into a resonant 24 dB low-pass with accent, slide and drive. Give steps (sixteenth notes), or patterns A to D with a chain. Also returns the notes so the line can go into an LMMS pattern.",
  params: obj({
    waveform: oneOf(["saw", "square"], "saw"),
    cutoff: unit(0.4),
    resonance: unit(0.62),
    envMod: unit(0.7),
    decay: unit(0.36),
    accent: unit(0.78),
    drive: unit(0.28),
    tempo: num(40, 240, { default: 124 }),
    swing: unit(0),
    cycles: num(1, 64, { default: 1, integer: true, description: "How many times to play the whole pattern or chain." }),
    rootMidi: num(0, 96, { default: 36, integer: true, description: "MIDI note of pitch class 0, octave 0." }),
    steps: steps("A single pattern of sixteenth-note steps. Use this or patterns."),
    patterns: obj(
      { A: steps(), B: steps(), C: steps(), D: steps() },
      { optional: true, description: "Up to four patterns played in chain order." },
    ),
    chain: list(oneOf(["A", "B", "C", "D"]), { min: 1, max: 64, optional: true }),
  }),
  example: {
    tempo: 128,
    steps: [
      { gate: true, note: 0, accent: true }, { gate: false }, { gate: true, note: 0 }, { gate: true, note: 3, slide: true },
      { gate: true, note: 5 }, { gate: false }, { gate: true, note: 7, octave: 0 }, { gate: true, note: 0, accent: true },
    ],
  },
  presets: (file) => {
    const patterns = {};
    for (const [id, slot] of Object.entries(file.patterns || {})) patterns[id] = Array.isArray(slot) ? slot : slot.steps;
    return [{ name: file.name, params: { ...file.params, patterns, chain: file.chain } }];
  },
  check(params) {
    if (params.steps && params.patterns) return "Give steps or patterns, not both.";
    if (!params.steps && !params.patterns) return "Give steps, or patterns with an optional chain.";
    if (params.chain && params.patterns && params.chain.some((id) => !params.patterns[id])) return "chain names a pattern that is not given.";
    return null;
  },
  pattern(params) {
    return params.steps ? { steps: params.steps } : { patterns: params.patterns, chain: params.chain || ["A"] };
  },
  render(params, { sampleRate }) {
    const out = renderAcidPattern(this.pattern(params), { ...params, sampleRate });
    return { sampleRate: out.sampleRate, channels: [out.samples], notes: this.notes(params) };
  },
  notes(params) {
    const resolved = resolveParams(params);
    const all = flattenPattern(this.pattern(params), resolved.cycles);
    const stepBeats = 0.25;
    const swing = resolved.swing * 0.5 * stepBeats;
    const at = (i) => i * stepBeats + (i % 2 === 1 ? swing : 0);
    const notes = [];
    all.forEach((s, i) => {
      if (!s.gate) return;
      const end = Math.min(at(i + 1), all.length * stepBeats);
      const span = end - at(i);
      const slides = s.slide && i + 1 < all.length && all[i + 1].gate;
      notes.push({
        midi: Math.min(127, resolved.rootMidi + s.octave * 12 + s.note),
        start: at(i),
        duration: slides ? span : span * 0.85,
        velocity: s.accent ? 0.88 : 0.6,
      });
    });
    return { bpm: resolved.tempo, lengthBeats: all.length * stepBeats, notes };
  },
};
