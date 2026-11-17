// Agent descriptor for the Trailer Riser & Impact. See agent/README.md.
import { num, oneOf, obj } from "../../shared/params.js";
import { KINDS, render } from "./engine.js";

export default {
  id: "trailer-riser",
  name: "Trailer Riser & Impact",
  role: "generator",
  summary: "Risers, whooshes, brass hits, sub drops, reverse swells and impacts. Set the length in seconds or in bars at a tempo so the peak lands on a downbeat. A tail is added after the gesture.",
  params: obj({
    kind: oneOf(KINDS.map((k) => k.id), "riser", KINDS.map((k) => `${k.id}: ${k.blurb}`).join(" ")),
    lengthMode: oneOf(["seconds", "bars"], "seconds", "Use bars with tempo to line the gesture up with a song."),
    seconds: num(0.2, 24, { default: 8, description: "Gesture length when lengthMode is seconds." }),
    bars: num(1, 16, { default: 4, integer: true, description: "Gesture length in 4/4 bars when lengthMode is bars." }),
    tempo: num(40, 240, { default: 120, description: "BPM used when lengthMode is bars." }),
    intensity: num(0, 1, { default: 0.72 }),
    pitch: num(16, 84, { default: 36, description: "MIDI note for the tonal centre." }),
    darkness: num(0, 1, { default: 0.4 }),
    size: num(0, 1, { default: 0.58, description: "Space and tail length." }),
    seed: num(1, 999999999, { default: 1, integer: true }),
  }),
  example: { kind: "riser", lengthMode: "bars", bars: 4, tempo: 128, intensity: 0.8 },
  presets: (file) => [{ name: file.name, params: file }],
  render(params, { sampleRate }) {
    const out = render(params, { sampleRate });
    return {
      sampleRate: out.sampleRate,
      channels: [out.left, out.right],
      info: { gestureSeconds: out.gestureDuration, tailSeconds: out.duration - out.gestureDuration },
    };
  },
};
