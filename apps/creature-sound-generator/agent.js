// Agent descriptor for the Creature Sound Generator. See agent/README.md.
import { num, oneOf, obj } from "../../shared/params.js";
import { GESTURES, MOODS, SPECIES, renderCreature } from "./engine.js";

export default {
  id: "creature-sound-generator",
  name: "Creature Sound Generator",
  role: "generator",
  summary: `Mono creature vocalisations. species morphs ${SPECIES.join(", ")} from 0 to 1; mood morphs ${MOODS.join(", ")}. gesture picks the call.`,
  params: obj({
    gesture: oneOf(GESTURES, "idle"),
    size: num(0, 1, { default: 0.5, description: "0 tiny, 1 huge." }),
    species: num(0, 1, { default: 0, description: SPECIES.map((s, i) => `${(i / (SPECIES.length - 1)).toFixed(2)} ${s}`).join(", ") }),
    mood: num(0, 1, { default: 0, description: MOODS.map((m, i) => `${(i / (MOODS.length - 1)).toFixed(2)} ${m}`).join(", ") }),
    roughness: num(0, 1, { default: 0.25 }),
    velocity: num(0, 1, { default: 1 }),
    seed: num(0, 4294967295, { default: 1, integer: true }),
  }),
  example: { gesture: "attack", size: 0.8, species: 0, mood: 0.33, roughness: 0.7 },
  presets: (list) =>
    (Array.isArray(list) ? list : [list]).map(({ name, ...params }) => ({ name, params })),
  render(params) {
    const { seed, ...rest } = params;
    const out = renderCreature(rest, seed);
    return { sampleRate: out.sampleRate, channels: [out.samples], info: { species: out.speciesName, mood: out.moodName } };
  },
};
