// Agent descriptor for Pump Sweep. See agent/README.md.
import { bool, list, num, oneOf, obj } from "../../shared/params.js";
import { RATES, processPumpSweep } from "./engine.js";

export default {
  id: "pump-sweep",
  name: "Pump Sweep",
  role: "processor",
  summary: "Tempo-locked sidechain pumping and a filter on a stem or mix. Performance moves are holds in seconds: build sweeps the filter open with a noise riser, drop sweeps it shut, cut mutes. Set bpm to the song tempo.",
  params: obj({
    bpm: num(40, 300, { default: 124 }),
    output: num(0, 1.5, { default: 1 }),
    riserSeed: num(0, 4294967295, { default: 1, integer: true }),
    pump: obj({
      enabled: bool(true),
      depth: num(0, 1, { default: 0.75 }),
      shape: num(0, 1, { default: 0.62 }),
      rate: oneOf(RATES, "1/4", "Note division per duck. T is triplet."),
      offset: num(0, 1, { default: 0, description: "Moves the duck within the division so it sits on the kick." }),
    }),
    filter: obj({
      enabled: bool(true),
      type: oneOf(["lowpass", "highpass", "bandpass"], "lowpass"),
      cutoff: num(20, 20000, { default: 14000, description: "Hz." }),
      resonance: num(0, 1, { default: 0.18 }),
    }),
    performance: list(
      obj({
        type: oneOf(["build", "drop", "cut"], undefined),
        start: num(0, 3600, { required: true }),
        end: num(0, 3600, { required: true }),
        sweepSeconds: num(0.05, 600, { optional: true, description: "Full travel time. Defaults to the hold length." }),
      }),
      { max: 512, default: [] },
    ),
  }),
  example: { bpm: 128, pump: { depth: 0.8 }, performance: [{ type: "build", start: 0, end: 7.5 }, { type: "drop", start: 7.5, end: 9 }] },
  presets: (file) => {
    if (Array.isArray(file)) return [];
    const { name, sweepBars, ...params } = file;
    return [{ name, params }];
  },
  check(params) {
    for (const [i, move] of params.performance.entries()) {
      if (!move.type) return `performance[${i}].type is required.`;
      if (move.end <= move.start) return `performance[${i}] ends before it starts.`;
    }
    return null;
  },
  process(audio, params) {
    const out = processPumpSweep({ sampleRate: audio.sampleRate, channels: audio.channels }, params);
    return { sampleRate: out.sampleRate, channels: out.channels };
  },
};
