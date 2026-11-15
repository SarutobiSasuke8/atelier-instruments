// Agent descriptor for the Vowel Choir Pad. See agent/README.md.
import { bool, list, num, obj } from "../../shared/params.js";
import { PRESET_SPEC, render } from "./engine.js";

const fromSpec = (key, description) => {
  const rule = PRESET_SPEC[key];
  if (rule.type === "boolean") return bool(rule.default, description);
  return num(rule.min, rule.max, { default: rule.default, integer: rule.integer, description });
};

export default {
  id: "vowel-choir-pad",
  name: "Vowel Choir Pad",
  role: "generator",
  summary: "A small formant choir holding up to 16 notes. vowelX and vowelY place the vowel on the ooh, oh, ah, eh, ee map, or sweep glides through them. One render is at most 30 seconds, so render longer parts in sections.",
  params: obj({
    notes: list(
      obj({
        midi: num(24, 96, { required: true, integer: true }),
        velocity: num(0, 1, { optional: true }),
        start: num(0, 30, { optional: true, description: "Seconds. Defaults to 0." }),
        end: num(0, 30, { optional: true, description: "Seconds. Defaults to the end of the render." }),
      }),
      { min: 1, max: 16, required: true },
    ),
    duration: num(0.1, 30, { default: 4, description: "Render length in seconds, including the release." }),
    vowelX: fromSpec("vowelX", "Left to right across the vowel map."),
    vowelY: fromSpec("vowelY"),
    choirSize: fromSpec("choirSize"),
    breathiness: fromSpec("breathiness"),
    vibrato: fromSpec("vibrato"),
    vibratoRate: fromSpec("vibratoRate", "Hz."),
    reverb: fromSpec("reverb"),
    sweep: fromSpec("sweep", "Glide through the vowels over time."),
    sweepRate: fromSpec("sweepRate", "Hz."),
    gain: num(0, 1.5, { default: 0.85 }),
    seed: num(0, 4294967295, { default: 1, integer: true }),
  }),
  example: { notes: [{ midi: 57 }, { midi: 60 }, { midi: 64 }], duration: 6, vowelX: 0.3, reverb: 0.6 },
  presets: (file) => {
    const { name, ...rest } = file;
    return [{ name, params: rest }];
  },
  check(params) {
    for (const note of params.notes) {
      if (note.end !== undefined && note.end <= (note.start ?? 0)) return `A note ends before it starts (midi ${note.midi}).`;
    }
    return null;
  },
  render(params, { sampleRate }) {
    const out = render({ ...params, sampleRate });
    return { sampleRate: out.sampleRate, channels: [out.left, out.right] };
  },
};
