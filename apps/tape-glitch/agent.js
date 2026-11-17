// Agent descriptor for Tape Glitch. See agent/README.md.
import { bool, list, num, oneOf, obj } from "../../shared/params.js";
import { EFFECTS, RANGES, defaultPreset, printGestures, render } from "./engine.js";

const defaults = defaultPreset();
const INTEGERS = new Set(["crushBits", "crushHold", "stutterMs", "dropoutMs"]);
const machine = {};
for (const [key, [min, max]] of Object.entries(RANGES)) {
  machine[key] = num(min, max, { default: defaults[key], integer: INTEGERS.has(key) });
}

export default {
  id: "tape-glitch",
  name: "Tape Glitch",
  role: "processor",
  summary: "Runs audio through a broken tape machine. Gestures switch an effect on between start and end seconds: wow, flutter, stop (pitch dives to silence), start (spins up), stutter, reverse, crush, dropout, and scratch (a curve of head positions from 0 to 1 through the source). With scripted true and no gestures, a demonstration pass is used.",
  params: obj({
    ...machine,
    slewMs: num(0, 40, { default: defaults.slewMs }),
    edgeMs: num(0, 40, { default: defaults.edgeMs }),
    seed: num(0, 4294967295, { default: 1, integer: true }),
    loop: bool(false, "Loop the source if the render is longer than it."),
    duration: num(0.05, 600, { optional: true, description: "Seconds. Defaults to the source length." }),
    scripted: bool(false, "Use the built-in scripted pass when no gestures are given."),
    gestures: list(
      obj({
        type: oneOf([...EFFECTS, "scratch"], undefined, "Effect to hold."),
        start: num(0, 600, { required: true }),
        end: num(0, 600, { required: true }),
        curve: list(obj({ t: num(0, 600, { required: true }), pos: num(0, 1, { required: true }) }), {
          min: 2,
          max: 256,
          optional: true,
          description: "Scratch only. Absolute times in seconds.",
        }),
      }),
      { max: 512, default: [] },
    ),
  }),
  example: { gestures: [{ type: "stutter", start: 1, end: 1.5 }, { type: "stop", start: 3.2, end: 4 }] },
  presets: (list) => (Array.isArray(list) ? list : [list]).map(({ name, ...params }) => ({ name, params })),
  check(params) {
    for (const [i, g] of params.gestures.entries()) {
      if (!g.type) return `gestures[${i}].type is required.`;
      if (g.end <= g.start) return `gestures[${i}] ends before it starts.`;
      if (g.type === "scratch" && !g.curve) return `gestures[${i}] is a scratch and needs a curve.`;
    }
    return null;
  },
  process(audio, params) {
    const { gestures, scripted, loop, duration, ...preset } = params;
    const length = duration ?? audio.channels[0].length / audio.sampleRate;
    const timeline = gestures.length
      ? gestures.map(({ start, end, ...rest }) => ({ ...rest, t0: start, t1: end }))
      : scripted
        ? printGestures(length)
        : [];
    const out = render({ channels: audio.channels, sampleRate: audio.sampleRate, preset, gestures: timeline, duration: length, loop, seed: params.seed });
    return { sampleRate: out.sampleRate, channels: out.channels };
  },
};
