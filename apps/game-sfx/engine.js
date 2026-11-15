/**
 * Game sound-effect renderer. No DOM and no Web Audio — pure buffers.
 * renderSfx(category, params, seed) is deterministic for a given triple.
 *
 * params (each 0..1, missing keys fall back to the center):
 *   pitch, length, punch, noise, sweep, style
 * style 0 is retro (pulse, crushed), style 1 is modern (smooth, filtered).
 */
function midiToFreq(note) {
  return 440 * 2 ** ((Number(note) - 69) / 12);
}

export const SAMPLE_RATE = 44100;

export const PARAM_KEYS = Object.freeze([
  "pitch",
  "length",
  "punch",
  "noise",
  "sweep",
  "style",
]);

export const CATEGORIES = Object.freeze([
  Object.freeze({ id: "jump", label: "Jump", blurb: "Rising leap" }),
  Object.freeze({ id: "coin", label: "Coin", blurb: "Two-note collect" }),
  Object.freeze({ id: "power-up", label: "Power-up", blurb: "Climbing prize" }),
  Object.freeze({ id: "laser", label: "Laser", blurb: "Falling beam" }),
  Object.freeze({ id: "explosion", label: "Explosion", blurb: "Blast and rumble" }),
  Object.freeze({ id: "hit", label: "Hit", blurb: "Impact smack" }),
  Object.freeze({ id: "pickup", label: "Pickup", blurb: "Soft chime" }),
  Object.freeze({ id: "menu-click", label: "Menu click", blurb: "Interface tick" }),
  Object.freeze({ id: "error", label: "Error", blurb: "Denied buzz" }),
  Object.freeze({ id: "level-up", label: "Level-up", blurb: "Short fanfare" }),
  Object.freeze({ id: "footstep", label: "Footstep", blurb: "Step thud" }),
]);

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

export const PACKS = Object.freeze({
  ui: Object.freeze({
    id: "ui",
    label: "UI pack",
    filename: "ui-pack.zip",
    categories: Object.freeze(["menu-click", "error", "pickup", "level-up"]),
  }),
  platformer: Object.freeze({
    id: "platformer",
    label: "Platformer pack",
    filename: "platformer-pack.zip",
    categories: Object.freeze([
      "jump",
      "footstep",
      "coin",
      "pickup",
      "power-up",
      "hit",
      "laser",
      "explosion",
    ]),
  }),
});

export function defaultParams() {
  return {
    pitch: 0.5,
    length: 0.5,
    punch: 0.55,
    noise: 0.25,
    sweep: 0.5,
    style: 0.35,
  };
}

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function clampParams(input) {
  const base = defaultParams();
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const key of PARAM_KEYS) {
    out[key] = src[key] === undefined ? base[key] : clamp01(src[key]);
  }
  return out;
}

export function normalizeCategory(category) {
  if (typeof category !== "string") return null;
  const key = category.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return CATEGORY_IDS.has(key) ? key : null;
}

export function categoryById(category) {
  const id = normalizeCategory(category);
  if (!id) return null;
  return CATEGORIES.find((c) => c.id === id) || null;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function varyAround(params, seed, amount = 0.18) {
  const rng = mulberry32(seed >>> 0);
  const current = clampParams(params);
  const out = {};
  const span = Math.max(0, Number(amount) || 0);
  for (const key of PARAM_KEYS) {
    out[key] = clamp01(current[key] + (rng() - 0.5) * 2 * span);
  }
  return out;
}

/** Small step away from a locked sound. `step` walks further each press. */
export function mutateLocked(snapshot, step = 1) {
  const category = normalizeCategory(snapshot && snapshot.category);
  if (!category) throw new Error("Cannot mutate an unknown category");
  const baseSeed = snapshot.seed >>> 0;
  const n = (Number(step) || 1) >>> 0;
  const salt = (baseSeed + Math.imul(n, 0x9e3779b9)) >>> 0;
  const params = varyAround(snapshot.params, salt, 0.07);
  const seed = (Math.imul(baseSeed ^ salt, 1664525) + Math.imul(n, 1013904223)) >>> 0;
  return { category, params, seed };
}

export function suggestedFileName(category, seed, packId = "") {
  const id = normalizeCategory(category);
  if (!id) throw new Error(`Unknown category: ${category}`);
  if (packId) {
    if (!/^[\w-]+$/.test(packId)) throw new Error("Bad pack id");
    return `${packId}-${id}.wav`;
  }
  const hex = (seed >>> 0).toString(16).padStart(8, "0");
  return `${id}-${hex}.wav`;
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

/** Frequency ratio. `neutral` is the ratio at sweep 0.5; `depth` is extra octaves. */
function sweepMul(sweep, neutral, depth) {
  const bipolar = (clamp01(sweep) - 0.5) * 2;
  return neutral * 2 ** (bipolar * depth);
}

function baseMidi(center, pitch) {
  return center + (clamp01(pitch) - 0.5) * 24;
}

function hashNoise(seed, i) {
  let x = (Math.imul(i + 1, 0x9e3779b1) ^ (seed >>> 0)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return (x / 4294967295) * 2 - 1;
}

function polyblep(t, dt) {
  if (!(dt > 0)) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function wrap01(x) {
  return x - Math.floor(x);
}

function oscSample(wave, phase, dt, duty) {
  const t = wrap01(phase);
  if (wave === "sine") return Math.sin(2 * Math.PI * t);
  if (wave === "triangle") return 1 - 4 * Math.abs(t - 0.5);
  if (wave === "saw") return 2 * t - 1 - polyblep(t, dt);
  const d = duty > 0.05 && duty < 0.95 ? duty : 0.5;
  let v = t < d ? 1 : -1;
  v += polyblep(t, dt);
  v -= polyblep(wrap01(t - d), dt);
  return v;
}

function glide(f0, f1, u) {
  const a = Math.max(1, f0);
  const b = Math.max(1, f1);
  return a * (b / a) ** u;
}

function envelope(local, dur, attack) {
  if (local < 0 || local > dur || dur <= 0) return 0;
  const a = Math.min(Math.max(attack, 0), dur * 0.45);
  const gate = a > 0 && local < a ? local / a : 1;
  const rest = Math.max(1e-5, dur - a);
  const u = Math.min(1, Math.max(0, (local - a) / rest));
  return gate * 0.002 ** u;
}

function tone(partial) {
  return {
    type: "tone",
    waveRetro: "square",
    waveModern: "sine",
    attack: 0.004,
    amp: 0.4,
    duty: 0.5,
    ...partial,
  };
}

function noise(partial) {
  return {
    type: "noise",
    attack: 0.001,
    amp: 0.3,
    color: 0.25,
    ...partial,
  };
}

function jump(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.09, 0.32, p.length);
  const f0 = midiToFreq(baseMidi(64, p.pitch) + (rng() - 0.5) * 1.4);
  const f1 = f0 * sweepMul(p.sweep, 2.15, 1.05);
  return {
    duration: dur,
    layers: [
      tone({
        t0: 0,
        t1: dur,
        f0,
        f1,
        amp: 0.58,
        attack: lerp(0.012, 0.002, p.punch),
        duty: 0.22 + rng() * 0.22,
        waveRetro: "square",
        waveModern: "sine",
      }),
      noise({ t0: 0, t1: dur * 0.4, amp: 0.28 * p.noise, color: 0.12, attack: 0.001 }),
      tone({
        t0: 0,
        t1: Math.min(0.035, dur * 0.4),
        f0: f0 * 0.5,
        f1: f0 * 0.5,
        amp: 0.42 * p.punch,
        attack: 0.001,
        waveRetro: "sine",
        waveModern: "sine",
      }),
    ],
  };
}

function coin(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.12, 0.38, p.length);
  const roll = Math.floor(rng() * 5);
  const interval = roll === 0 ? 12 : roll === 1 ? 4 : 7;
  const m = baseMidi(83, p.pitch);
  const split = dur * (0.4 + (rng() - 0.5) * 0.06);
  const glideRatio = sweepMul(p.sweep, 1, 0.35);
  const fA = midiToFreq(m);
  const fB = midiToFreq(m + interval);
  return {
    duration: dur,
    layers: [
      tone({
        t0: 0,
        t1: split,
        f0: fA,
        f1: fA * glideRatio,
        amp: 0.5,
        attack: 0.002,
        duty: 0.5,
        waveRetro: "square",
        waveModern: "triangle",
      }),
      tone({
        t0: split * 0.92,
        t1: dur,
        f0: fB,
        f1: fB * glideRatio,
        amp: 0.48,
        attack: 0.002,
        duty: 0.5,
        waveRetro: "square",
        waveModern: "triangle",
      }),
      noise({ t0: 0, t1: dur * 0.18, amp: 0.16 * p.noise, color: 0.08 }),
      tone({
        t0: 0,
        t1: 0.012,
        f0: fA * 2,
        f1: fA * 2,
        amp: 0.22 * p.punch,
        attack: 0.0008,
        waveRetro: "sine",
        waveModern: "sine",
      }),
    ],
  };
}

function powerUp(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.32, 1.02, p.length);
  const steps = [0, 4, 7, 12, 19];
  const m = baseMidi(60, p.pitch) + (rng() - 0.5) * 0.6;
  const glideRatio = sweepMul(p.sweep, 1.12, 0.5);
  const layers = [];
  steps.forEach((semi, i) => {
    const t0 = (i / steps.length) * dur * 0.9;
    const t1 = Math.min(dur, t0 + (dur / steps.length) * 0.95);
    const f = midiToFreq(m + semi);
    layers.push(
      tone({
        t0,
        t1,
        f0: f,
        f1: f * glideRatio,
        amp: 0.4,
        attack: 0.003,
        duty: 0.22 + rng() * 0.2,
        waveRetro: "square",
        waveModern: "triangle",
      }),
    );
  });
  layers.push(noise({ t0: 0, t1: dur * 0.22, amp: 0.14 * p.noise, color: 0.05 }));
  layers.push(
    tone({
      t0: 0,
      t1: 0.02,
      f0: midiToFreq(m),
      f1: midiToFreq(m + 12),
      amp: 0.28 * p.punch,
      attack: 0.001,
      waveRetro: "square",
      waveModern: "sine",
    }),
  );
  return { duration: dur, layers };
}

function laser(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.12, 0.55, p.length);
  const f0 = midiToFreq(baseMidi(90, p.pitch) + (rng() - 0.5) * 2.5);
  const f1 = f0 * sweepMul(p.sweep, 0.4, 1.4);
  return {
    duration: dur,
    layers: [
      tone({
        t0: 0,
        t1: dur,
        f0,
        f1,
        amp: 0.5,
        attack: lerp(0.01, 0.002, p.punch),
        duty: 0.18 + rng() * 0.22,
        waveRetro: "square",
        waveModern: "saw",
      }),
      noise({ t0: 0, t1: dur * 0.9, amp: 0.06 + p.noise * 0.42, color: 0.22, attack: 0.002 }),
      tone({
        t0: 0,
        t1: Math.min(0.018, dur * 0.25),
        f0: f0 * 1.4,
        f1: f0,
        amp: 0.26 * p.punch,
        attack: 0.0008,
        waveRetro: "square",
        waveModern: "sine",
      }),
    ],
  };
}

function explosion(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.28, 1.15, p.length);
  const f0 = midiToFreq(baseMidi(38, p.pitch) + (rng() - 0.5) * 5);
  const f1 = f0 * sweepMul(p.sweep, 0.45, 1);
  return {
    duration: dur,
    layers: [
      noise({
        t0: 0,
        t1: dur,
        amp: 0.22 + p.noise * 0.55,
        color: 0.5 + rng() * 0.25,
        attack: 0.002,
      }),
      tone({
        t0: 0,
        t1: dur,
        f0,
        f1,
        amp: 0.62,
        attack: 0.006,
        waveRetro: "sine",
        waveModern: "sine",
      }),
      noise({
        t0: 0,
        t1: Math.min(0.09, dur * 0.22),
        amp: 0.75 * p.punch,
        color: 0.05,
        attack: 0.0005,
      }),
      tone({
        t0: 0,
        t1: Math.min(0.05, dur * 0.16),
        f0: f0 * 2.4,
        f1: f0,
        amp: 0.28 * p.punch,
        attack: 0.001,
        waveRetro: "square",
        waveModern: "triangle",
      }),
    ],
  };
}

function hit(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.045, 0.2, p.length);
  const f = midiToFreq(baseMidi(46, p.pitch) + (rng() - 0.5) * 3);
  return {
    duration: dur,
    layers: [
      noise({
        t0: 0,
        t1: dur,
        amp: 0.28 + p.noise * 0.4,
        color: 0.32,
        attack: 0.0008,
      }),
      tone({
        t0: 0,
        t1: dur,
        f0: f,
        f1: f * sweepMul(p.sweep, 0.55, 0.7),
        amp: 0.48,
        attack: 0.001,
        waveRetro: "sine",
        waveModern: "sine",
      }),
      tone({
        t0: 0,
        t1: Math.min(0.016, dur * 0.45),
        f0: f * (2.2 + rng()),
        f1: f,
        amp: 0.62 * p.punch,
        attack: 0.0004,
        waveRetro: "square",
        waveModern: "sine",
      }),
    ],
  };
}

function pickup(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.14, 0.42, p.length);
  const m = baseMidi(79, p.pitch);
  const split = dur * (0.34 + rng() * 0.12);
  const glideRatio = sweepMul(p.sweep, 1, 0.28);
  return {
    duration: dur,
    layers: [
      tone({
        t0: 0,
        t1: split * 1.2,
        f0: midiToFreq(m),
        f1: midiToFreq(m) * glideRatio,
        amp: 0.42,
        attack: 0.005,
        waveRetro: "triangle",
        waveModern: "sine",
      }),
      tone({
        t0: split,
        t1: dur,
        f0: midiToFreq(m + 4),
        f1: midiToFreq(m + 7) * glideRatio,
        amp: 0.4,
        attack: 0.004,
        waveRetro: "triangle",
        waveModern: "sine",
      }),
      noise({ t0: 0, t1: dur * 0.25, amp: 0.12 * p.noise, color: 0.15 }),
      tone({
        t0: 0,
        t1: 0.018,
        f0: midiToFreq(m + 12),
        f1: midiToFreq(m + 12),
        amp: 0.2 * p.punch,
        attack: 0.001,
        waveRetro: "sine",
        waveModern: "sine",
      }),
    ],
  };
}

function menuClick(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.016, 0.06, p.length);
  const f = midiToFreq(baseMidi(96, p.pitch) + (rng() - 0.5) * 2);
  return {
    duration: dur,
    layers: [
      tone({
        t0: 0,
        t1: dur,
        f0: f,
        f1: f * sweepMul(p.sweep, 1, 0.45),
        amp: 0.42,
        attack: 0.0006,
        duty: 0.35,
        waveRetro: "square",
        waveModern: "sine",
      }),
      noise({ t0: 0, t1: dur * 0.5, amp: 0.12 + p.noise * 0.4, color: 0.18, attack: 0.0003 }),
      tone({
        t0: 0,
        t1: Math.min(0.008, dur),
        f0: f * 1.5,
        f1: f,
        amp: 0.36 * p.punch,
        attack: 0.0003,
        waveRetro: "square",
        waveModern: "sine",
      }),
    ],
  };
}

function error(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.18, 0.55, p.length);
  const m = baseMidi(58, p.pitch) + (rng() - 0.5);
  const glideRatio = sweepMul(p.sweep, 0.9, 0.45);
  return {
    duration: dur,
    layers: [
      tone({
        t0: 0,
        t1: dur,
        f0: midiToFreq(m + 6),
        f1: midiToFreq(m + 6) * glideRatio,
        amp: 0.36,
        attack: lerp(0.02, 0.004, p.punch),
        duty: 0.28,
        waveRetro: "square",
        waveModern: "saw",
      }),
      tone({
        t0: dur * 0.1,
        t1: dur,
        f0: midiToFreq(m + 1),
        f1: midiToFreq(m - 1) * glideRatio,
        amp: 0.34,
        attack: 0.01,
        duty: 0.32,
        waveRetro: "square",
        waveModern: "triangle",
      }),
      noise({ t0: 0, t1: dur * 0.35, amp: 0.14 * p.noise, color: 0.12 }),
    ],
  };
}

function levelUp(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.42, 1.22, p.length);
  const steps = [0, 4, 7, 12, 16];
  const m = baseMidi(67, p.pitch) + (rng() - 0.5) * 0.4;
  const glideRatio = sweepMul(p.sweep, 1.02, 0.25);
  const layers = [];
  const span = dur * 0.7;
  steps.forEach((semi, i) => {
    const t0 = (i / steps.length) * span;
    const t1 = i === steps.length - 1 ? dur * 0.76 : t0 + (span / steps.length) * 1.08;
    const f = midiToFreq(m + semi);
    layers.push(
      tone({
        t0,
        t1,
        f0: f,
        f1: f * glideRatio,
        amp: 0.34,
        attack: 0.004,
        duty: 0.38 + rng() * 0.12,
        waveRetro: "square",
        waveModern: "triangle",
      }),
    );
  });
  const chordAt = dur * 0.66;
  for (const semi of [0, 4, 7]) {
    const f = midiToFreq(m + 12 + semi);
    layers.push(
      tone({
        t0: chordAt,
        t1: dur,
        f0: f,
        f1: f * glideRatio,
        amp: 0.18,
        attack: 0.008,
        waveRetro: "square",
        waveModern: "sine",
      }),
    );
  }
  layers.push(noise({ t0: 0, t1: dur * 0.4, amp: 0.08 * p.noise, color: 0.18 }));
  layers.push(
    tone({
      t0: 0,
      t1: 0.025,
      f0: midiToFreq(m + 24),
      f1: midiToFreq(m + 19),
      amp: 0.16 * p.punch,
      attack: 0.001,
      waveRetro: "square",
      waveModern: "sine",
    }),
  );
  return { duration: dur, layers };
}

function footstep(p, seed) {
  const rng = mulberry32(seed);
  const dur = lerp(0.05, 0.18, p.length);
  const f = midiToFreq(baseMidi(40, p.pitch) + (rng() - 0.5) * 6);
  const gap = 0.012 + rng() * 0.03;
  const second = rng() > 0.42 && gap < dur * 0.75;
  const layers = [
    tone({
      t0: 0,
      t1: dur * 0.75,
      f0: f,
      f1: f * sweepMul(p.sweep, 0.7, 0.45),
      amp: 0.58,
      attack: 0.001,
      waveRetro: "sine",
      waveModern: "sine",
    }),
    noise({
      t0: 0,
      t1: dur,
      amp: 0.18 + p.noise * 0.5,
      color: 0.4 + rng() * 0.4,
      attack: 0.0008,
    }),
    noise({
      t0: 0,
      t1: Math.min(0.014, dur * 0.4),
      amp: 0.55 * p.punch,
      color: 0.08,
      attack: 0.0003,
    }),
  ];
  if (second) {
    layers.push(
      tone({
        t0: gap,
        t1: Math.min(dur, gap + dur * 0.6),
        f0: f * 1.18,
        f1: f * 0.82,
        amp: 0.32,
        attack: 0.001,
        waveRetro: "sine",
        waveModern: "sine",
      }),
    );
  }
  return { duration: dur, layers };
}

const RECIPES = {
  jump,
  coin,
  "power-up": powerUp,
  laser,
  explosion,
  hit,
  pickup,
  "menu-click": menuClick,
  error,
  "level-up": levelUp,
  footstep,
};

function mixLayer(buf, layer, style, seed) {
  const sr = SAMPLE_RATE;
  const t0 = Math.max(0, layer.t0 || 0);
  const t1 = Math.max(t0, layer.t1 || 0);
  let i0 = Math.floor(t0 * sr);
  let i1 = Math.ceil(t1 * sr);
  if (i0 >= buf.length || i1 <= i0) return;
  if (i0 < 0) i0 = 0;
  if (i1 > buf.length) i1 = buf.length;
  const dur = t1 - t0;
  const amp = layer.amp || 0;
  if (amp === 0) return;

  if (layer.type === "noise") {
    let brown = 0;
    const color = clamp01(layer.color ?? 0.2);
    const noiseSeed = (seed + Math.imul(i0 + 17, 0x45d9f3b)) >>> 0;
    for (let i = i0; i < i1; i += 1) {
      const t = i / sr;
      const white = hashNoise(noiseSeed, i);
      brown = brown * 0.985 + white * 0.015;
      const n = white * (1 - color) + brown * 14 * color;
      const env = envelope(t - t0, dur, layer.attack ?? 0.001);
      buf[i] += n * env * amp;
    }
    return;
  }

  let phase = 0;
  const f0 = layer.f0;
  const f1 = layer.f1 === undefined ? f0 : layer.f1;
  const span = Math.max(1, i1 - i0);
  for (let i = i0; i < i1; i += 1) {
    const u = (i - i0) / span;
    const f = glide(f0, f1, u);
    const dt = f / sr;
    phase += dt;
    const retro = oscSample(layer.waveRetro || "square", phase, dt, layer.duty);
    const modern = oscSample(layer.waveModern || "sine", phase, dt, layer.duty);
    const sample = retro * (1 - style) + modern * style;
    const env = envelope(i / sr - t0, dur, layer.attack ?? 0.004);
    buf[i] += sample * env * amp;
  }
}

function applyEra(buf, style) {
  const retro = 1 - clamp01(style);
  if (retro < 0.04) return;
  const hold = 1 + Math.round(retro * 6);
  const steps = 2 ** (5 + clamp01(style) * 6);
  let last = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (i % hold === 0) last = Math.round(buf[i] * steps) / steps;
    buf[i] = last;
  }
}

function lowpass(buf, style) {
  const cutoff = 2600 + (1 - clamp01(style)) * 9800;
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let y = 0;
  for (let i = 0; i < buf.length; i += 1) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
}

function dcBlock(buf) {
  let prevX = 0;
  let prevY = 0;
  const r = 0.995;
  for (let i = 0; i < buf.length; i += 1) {
    const x = buf[i];
    const y = x - prevX + r * prevY;
    prevX = x;
    prevY = y;
    buf[i] = y;
  }
}

function fadeEdges(buf) {
  const inN = Math.min(buf.length >> 1, Math.round(0.002 * SAMPLE_RATE));
  const outN = Math.min(buf.length >> 1, Math.round(0.008 * SAMPLE_RATE));
  for (let i = 0; i < inN; i += 1) buf[i] *= i / Math.max(1, inN);
  for (let i = 0; i < outN; i += 1) buf[buf.length - 1 - i] *= i / Math.max(1, outN);
}

function tamePeak(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-8) return;
  let gain = 1;
  if (peak > 0.97) gain = 0.97 / peak;
  else if (peak < 0.42) gain = 0.82 / peak;
  if (gain !== 1) {
    for (let i = 0; i < buf.length; i += 1) buf[i] *= gain;
  }
  for (let i = 0; i < buf.length; i += 1) {
    const x = buf[i];
    if (x > 1 || x < -1) buf[i] = Math.tanh(x);
  }
}

function renderRecipe(spec, style, seed) {
  const n = Math.max(16, Math.round(spec.duration * SAMPLE_RATE));
  const buf = new Float32Array(n);
  spec.layers.forEach((layer, index) => {
    mixLayer(buf, layer, style, (seed + index * 4099) >>> 0);
  });
  applyEra(buf, style);
  lowpass(buf, style);
  dcBlock(buf);
  fadeEdges(buf);
  tamePeak(buf);
  return buf;
}

export function renderSfx(category, params, seed) {
  const meta = categoryById(category);
  if (!meta) throw new Error(`Unknown category: ${category}`);
  const clean = clampParams(params);
  const resolved = seed === undefined || seed === null ? 1 : seed >>> 0;
  const recipe = RECIPES[meta.id](clean, resolved);
  const samples = renderRecipe(recipe, clean.style, resolved);
  return {
    category: meta.id,
    label: meta.label,
    seed: resolved,
    params: clean,
    sampleRate: SAMPLE_RATE,
    samples,
    duration: samples.length / SAMPLE_RATE,
    suggestedName: suggestedFileName(meta.id, resolved),
  };
}
