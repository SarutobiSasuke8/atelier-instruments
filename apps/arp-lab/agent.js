// Agent descriptor for the Arpeggiator Lab. See agent/README.md.
import { list, num, numOrList, oneOf, obj } from "../../shared/params.js";
import { ARP_MODES, renderArp } from "./engine.js";
import { renderVoices } from "./synth-offline.js";

function presetChords(file) {
  const bars = Math.max(1, Math.min(16, file.bars || 4));
  const slots = (file.slots || []).filter((slot) => Array.isArray(slot) && slot.length);
  if (file.walk && slots.length) {
    return Array.from({ length: bars }, (_, i) => ({ notes: slots[i % slots.length], start: i * 4, length: 4 }));
  }
  return [{ notes: file.sounding || [60, 64, 67], start: 0, length: bars * 4 }];
}

export default {
  id: "arp-lab",
  name: "Arpeggiator Lab",
  role: "generator",
  summary: "Arpeggiates a chord timeline with mode, rate, octaves, swing, and per-step probability, ratchets and accents, then plays it on a small subtractive synth. Times are in beats. Also returns the arpeggiated notes, which are often more useful in LMMS than the synth audio.",
  params: obj({
    bpm: num(20, 400, { default: 120 }),
    chords: list(
      obj({
        notes: list(num(0, 127, { integer: true }), { min: 1, max: 12, required: true }),
        start: num(0, 1024, { required: true, description: "Beats." }),
        length: num(0.0625, 256, { required: true, description: "Beats." }),
      }),
      { min: 1, max: 256, required: true },
    ),
    arp: obj({
      mode: oneOf(ARP_MODES, "up"),
      rate: num(0.25, 32, { default: 4, description: "Steps per beat. 4 is sixteenth notes." }),
      gate: num(0, 1, { default: 0.65 }),
      octaves: num(1, 6, { default: 1, integer: true }),
      swing: num(0, 1, { default: 0 }),
      steps: num(1, 64, { default: 16, integer: true, description: "Length of the per-step lanes." }),
      probability: numOrList(0, 1, { default: 1 }),
      ratchets: numOrList(1, 8, { default: 1 }),
      accents: numOrList(0, 1, { default: 0, description: "1 accents a step." }),
      velocity: num(1, 127, { default: 104, integer: true }),
      accentVelocity: num(1, 127, { default: 127, integer: true }),
      seed: num(0, 4294967295, { default: 1, integer: true }),
    }),
    synth: obj({
      waveform: oneOf(["saw", "square", "triangle", "sine"], "saw"),
      cutoff: num(40, 14000, { default: 1800, description: "Hz." }),
      resonance: num(0, 0.92, { default: 0.25 }),
      attack: num(0.001, 2, { default: 0.008 }),
      decay: num(0.001, 4, { default: 0.16 }),
      sustain: num(0, 1, { default: 0.35 }),
      release: num(0.01, 4, { default: 0.2 }),
      gain: num(0, 1, { default: 0.8 }),
    }),
  }),
  example: {
    bpm: 124,
    chords: [{ notes: [57, 60, 64], start: 0, length: 8 }, { notes: [53, 57, 60], start: 8, length: 8 }],
    arp: { mode: "up-down", octaves: 2, gate: 0.5 },
  },
  presets: (list) =>
    (Array.isArray(list) ? list : [list]).map((file) => ({
      name: file.name,
      params: { bpm: file.bpm, chords: presetChords(file), arp: file.arp, synth: file.synth },
    })),
  render(params, { sampleRate }) {
    const { events } = renderArp(params.chords, params.arp);
    const mono = renderVoices(events, { ...params.synth, bpm: params.bpm, sampleRate });
    return { sampleRate, channels: [mono], notes: this.notes(params, events) };
  },
  notes(params, events = renderArp(params.chords, params.arp).events) {
    const lengthBeats = params.chords.reduce((end, c) => Math.max(end, c.start + c.length), 0);
    return {
      bpm: params.bpm,
      lengthBeats,
      notes: events.map((e) => ({ midi: e.note, start: e.start, duration: e.duration, velocity: e.velocity / 127 })),
    };
  },
};
