// Agent descriptor for the Game Sound Effects Maker. See agent/README.md.
import { num, oneOf, obj } from "../../shared/params.js";
import { CATEGORIES, renderSfx } from "./engine.js";

const unit = (value, description) => num(0, 1, { default: value, description });

export default {
  id: "game-sfx",
  name: "Game Sound Effects Maker",
  role: "generator",
  summary: "Short mono game sounds: jump, coin, power-up, laser, explosion, hit, pickup, menu click, error, level-up and footstep. The same category, params and seed always give the same sound.",
  params: obj({
    category: oneOf(CATEGORIES.map((c) => c.id), "jump", CATEGORIES.map((c) => `${c.id}: ${c.blurb}`).join(". ")),
    pitch: unit(0.5),
    length: unit(0.5),
    punch: unit(0.55),
    noise: unit(0.25),
    sweep: unit(0.5),
    style: unit(0.35, "0 is retro chip, 1 is modern."),
    seed: num(0, 4294967295, { default: 1, integer: true }),
  }),
  example: { category: "coin", pitch: 0.6, seed: 7 },
  presets: (file) =>
    (file.items || []).map((item) => ({ name: item.name, params: { category: item.category, seed: item.seed, ...item.params } })),
  render(params) {
    const { category, seed, ...rest } = params;
    const out = renderSfx(category, rest, seed);
    return { sampleRate: out.sampleRate, channels: [out.samples], info: { suggestedName: out.suggestedName } };
  },
};
