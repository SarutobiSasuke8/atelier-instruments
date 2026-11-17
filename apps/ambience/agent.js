// Agent descriptor for Ambience. See agent/README.md.
import { list, num, oneOf, obj } from "../../shared/params.js";
import { KINDS, MAX_LAYERS, MAX_SECONDS, renderAmbience } from "./engine.js";

const unit = (value, description) => num(0, 1, { default: value, description });

export default {
  id: "ambience",
  name: "Ambience",
  role: "generator",
  summary: "A seamless looping bed of up to six procedural textures. The end joins the start, so the file can loop on a sample track.",
  params: obj({
    seconds: num(1, MAX_SECONDS, { default: 12, description: "Loop length in seconds." }),
    mood: unit(0.35, "0 is calm, 1 is tense."),
    seed: num(0, 4294967295, { default: 1, integer: true }),
    layers: list(
      obj({
        kind: oneOf(KINDS, "drone"),
        level: unit(0.7),
        tone: unit(0.5),
        movement: unit(0.4),
        density: unit(0.5),
      }),
      { min: 1, max: MAX_LAYERS, required: true, description: `1 to ${MAX_LAYERS} layers.` },
    ),
  }),
  example: { seconds: 16, mood: 0.2, layers: [{ kind: "rain", level: 0.8 }, { kind: "drone", level: 0.3, tone: 0.2 }] },
  presets: (file) => [{ name: file.name, params: { mood: file.mood, seed: file.seed, layers: file.layers } }],
  render(params) {
    const out = renderAmbience({ mood: params.mood, layers: params.layers }, params.seconds, params.seed);
    return { sampleRate: 44100, channels: [out.left, out.right] };
  },
};
