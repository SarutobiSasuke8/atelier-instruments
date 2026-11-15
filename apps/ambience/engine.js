/* Atelier Instruments — MIT License
   Ambient texture renderer. No DOM, no clock, no Math.random.
   renderAmbience(layers, seconds, seed) returns a seamless stereo loop. */

export const SAMPLE_RATE = 44100;
export const MAX_LAYERS = 6;
export const MAX_SECONDS = 180;

export const KINDS = Object.freeze([
  "drone",
  "rain",
  "wind",
  "cave",
  "forest",
  "ocean",
  "city",
  "space",
  "dread",
]);

export const KIND_LABELS = Object.freeze({
  drone: "Drone",
  rain: "Rain",
  wind: "Wind",
  cave: "Cave",
  forest: "Forest",
  ocean: "Ocean",
  city: "City hum",
  space: "Space",
  dread: "Dread",
});

const KIND_ALIAS = Object.freeze({
  "city hum": "city",
  cityhum: "city",
});

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  const text = String(seed ?? 1);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mixSeed(seed, index) {
  let x = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextGap(rand, rate) {
  const u = Math.min(rand(), 0.999999);
  return -Math.log(1 - u) / Math.max(rate, 0.0001);
}

function schedule(rand, rate, totalSamples, sampleRate, decorate) {
  const events = [];
  const duration = totalSamples / sampleRate;
  const cap = Math.min(24000, Math.ceil(duration * Math.max(rate, 0.01) * 4) + 4);
  let t = nextGap(rand, rate) * 0.35;
  while (t < duration && events.length < cap) {
    const event = decorate(rand, t);
    event.start = Math.min(totalSamples - 1, Math.floor(t * sampleRate));
    events.push(event);
    t += Math.max(1 / sampleRate, nextGap(rand, rate));
  }
  return events;
}

function panGains(p) {
  const angle = clamp01((p + 1) * 0.5, 0.5) * Math.PI * 0.5;
  return [Math.cos(angle), Math.sin(angle)];
}

function advance(phase, inc) {
  phase += inc;
  if (phase >= Math.PI * 2) phase -= Math.PI * 2;
  return phase;
}

/**
 * Accept an array of layers or `{ mood, layers }`.
 * Unknown kinds become drone. Only the first 6 layers are kept.
 */
export function normalizeSpec(layers) {
  const source = Array.isArray(layers) ? { layers } : layers || {};
  const mood = clamp01(source.mood, 0.35);
  const list = Array.isArray(source.layers) ? source.layers : [];
  const out = [];
  for (let i = 0; i < list.length && out.length < MAX_LAYERS; i += 1) {
    const layer = list[i];
    if (!layer || typeof layer !== "object") continue;
    const raw = String(layer.kind || "drone").toLowerCase().trim();
    const kind = KINDS.includes(raw) ? raw : KIND_ALIAS[raw] || "drone";
    out.push({
      kind,
      level: clamp01(layer.level, 0.7),
      tone: clamp01(layer.tone, 0.5),
      movement: clamp01(layer.movement, 0.4),
      density: clamp01(layer.density, 0.5),
    });
  }
  return { mood, layers: out };
}

function createDrone(layer, mood, rand, sampleRate) {
  const out = [0, 0];
  const base = 46 * 2 ** (layer.tone * 3.1);
  const tense = mood > 0.5;
  const ratios = tense
    ? [1, 1.4983, 1.6818, 2, 2.378, 2.9966, 4.05]
    : [1, 1.5, 2, 2.52, 3, 4, 5.04];
  const count = 3 + Math.round(layer.density * 4);
  const partials = [];
  for (let i = 0; i < count; i += 1) {
    const detune = (rand() - 0.5) * (0.003 + mood * 0.018);
    partials.push({
      inc: (2 * Math.PI * base * ratios[i % ratios.length] * (1 + detune)) / sampleRate,
      phase: rand() * Math.PI * 2,
      amp: 1 / (1 + i * 0.72),
      lfo: rand() * Math.PI * 2,
      lfoInc: (2 * Math.PI * (0.02 + layer.movement * 0.28) * (0.65 + mood * 0.7)) / sampleRate,
    });
  }
  const [gl, gr] = panGains((rand() - 0.5) * 1.1);
  const gain = layer.level * 0.2;
  return function drone() {
    let s = 0;
    for (let p = 0; p < partials.length; p += 1) {
      const part = partials[p];
      const wobble = 0.62 + 0.38 * Math.sin(part.lfo);
      s += Math.sin(part.phase) * part.amp * wobble;
      part.phase = advance(part.phase, part.inc);
      part.lfo = advance(part.lfo, part.lfoInc);
    }
    const shaped = Math.tanh(s * (0.85 + mood * 0.35));
    out[0] = shaped * gain * gl;
    out[1] = shaped * gain * gr;
    return out;
  };
}

function createNoiseBed(layer, mood, rand, sampleRate) {
  const out = [0, 0];
  let lp = 0;
  const gustInc = (2 * Math.PI * (0.04 + layer.movement * 0.6) * (0.7 + mood)) / sampleRate;
  let gust = rand() * Math.PI * 2;
  const [gl, gr] = panGains((rand() - 0.5) * 1.5);
  const gain = layer.level * 0.34;
  const cutBase = 0.03 + layer.tone * 0.28;
  return function bed() {
    const w = rand() * 2 - 1;
    const gustAmp = 0.28 + 0.72 * (0.5 + 0.5 * Math.sin(gust));
    gust = advance(gust, gustInc);
    lp += cutBase * (0.55 + gustAmp) * (w - lp);
    const s = lp * gustAmp * gain * (0.45 + layer.density * 0.7);
    out[0] = s * gl;
    out[1] = s * gr;
    return out;
  };
}

function createDroplets(layer, mood, rand, sampleRate, total, profile) {
  const out = [0, 0];
  const rate = profile.rate * (0.75 + mood * 0.7);
  const events = schedule(rand, rate, total, sampleRate, (rng) => {
    const decaySeconds = profile.decay[0] + rng() * (profile.decay[1] - profile.decay[0]);
    const gains = panGains(rng() * 2 - 1);
    return {
      amp: 0.25 + rng() * 0.75,
      decay: Math.exp(-1 / (sampleRate * decaySeconds)),
      gl: gains[0],
      gr: gains[1],
    };
  });
  const pool = [];
  for (let i = 0; i < profile.voices; i += 1) {
    pool.push({ env: 0, decay: 0, gl: 0, gr: 0, on: false });
  }
  let next = 0;
  let lp = 0;
  const tone = layer.tone;
  const gain = layer.level * profile.gain;
  return function droplets(i) {
    while (next < events.length && events[next].start <= i) {
      const ev = events[next];
      next += 1;
      for (let p = 0; p < pool.length; p += 1) {
        if (!pool[p].on) {
          pool[p].on = true;
          pool[p].env = ev.amp;
          pool[p].decay = ev.decay;
          pool[p].gl = ev.gl;
          pool[p].gr = ev.gr;
          break;
        }
      }
    }
    let left = 0;
    let right = 0;
    for (let p = 0; p < pool.length; p += 1) {
      const drop = pool[p];
      if (!drop.on) continue;
      const s = (rand() * 2 - 1) * drop.env;
      left += s * drop.gl;
      right += s * drop.gr;
      drop.env *= drop.decay;
      if (drop.env < 0.001) drop.on = false;
    }
    const cut = 0.08 + (1 - tone) * 0.45;
    const mid = (left + right) * 0.5;
    lp += cut * (mid - lp);
    const bright = mid - lp;
    const colored = lp * (1 - tone) + bright * (0.35 + tone);
    out[0] = (left * 0.65 + colored) * gain;
    out[1] = (right * 0.65 + colored) * gain;
    return out;
  };
}

function createRain(layer, mood, rand, sampleRate, total) {
  return createDroplets(layer, mood, rand, sampleRate, total, {
    rate: 2.5 + layer.density * 55,
    decay: [0.012, 0.055],
    voices: 24,
    gain: 0.42,
  });
}

function createCave(layer, mood, rand, sampleRate, total) {
  const drips = createDroplets(
    { ...layer, level: 1 },
    mood,
    rand,
    sampleRate,
    total,
    {
      rate: 0.12 + layer.density * 2.2,
      decay: [0.02, 0.09],
      voices: 8,
      gain: 0.55,
    },
  );
  const drone = createDrone(
    {
      kind: "drone",
      level: 0.55,
      tone: layer.tone * 0.35,
      movement: layer.movement * 0.5,
      density: 0.35 + layer.density * 0.2,
    },
    mood * 0.6,
    mulberry32(mixSeed((rand() * 1e9) >>> 0, 3)),
    sampleRate,
  );
  const delayLen = Math.max(32, Math.floor(sampleRate * (0.08 + (1 - layer.tone) * 0.22)));
  const bufL = new Float32Array(delayLen);
  const bufR = new Float32Array(delayLen);
  let w = 0;
  let dampL = 0;
  let dampR = 0;
  const feedback = 0.42 + layer.density * 0.28;
  const damp = 0.18 + (1 - layer.tone) * 0.25;
  const out = [0, 0];
  const gain = layer.level;
  return function cave(i) {
    const drop = drips(i);
    const bed = drone(i);
    const inL = drop[0] * 0.9 + bed[0] * 0.55;
    const inR = drop[1] * 0.9 + bed[1] * 0.55;
    const readL = bufL[w];
    const readR = bufR[w];
    dampL += damp * (inL + readL * feedback - dampL);
    dampR += damp * (inR + readR * feedback - dampR);
    bufL[w] = dampL;
    bufR[w] = dampR;
    w += 1;
    if (w >= delayLen) w = 0;
    out[0] = (inL * 0.65 + readL) * gain;
    out[1] = (inR * 0.65 + readR) * gain;
    return out;
  };
}

function createChirps(layer, mood, rand, sampleRate, total, profile) {
  const out = [0, 0];
  const rate = profile.rate * (0.8 + mood * 0.5);
  const events = schedule(rand, rate, total, sampleRate, (rng) => {
    const gains = panGains(rng() * 2 - 1);
    return {
      len: Math.floor(sampleRate * (profile.len[0] + rng() * (profile.len[1] - profile.len[0]))),
      f0: profile.f0(rng, layer),
      f1: profile.f1(rng, layer),
      amp: profile.amp[0] + rng() * (profile.amp[1] - profile.amp[0]),
      phase: rng() * Math.PI * 2,
      gl: gains[0],
      gr: gains[1],
    };
  });
  let next = 0;
  const active = [];
  const gain = layer.level * profile.gain;
  return function chirps(i) {
    while (next < events.length && events[next].start <= i) {
      active.push(events[next]);
      next += 1;
    }
    let left = 0;
    let right = 0;
    for (let k = active.length - 1; k >= 0; k -= 1) {
      const ev = active[k];
      const age = i - ev.start;
      if (age >= ev.len) {
        active.splice(k, 1);
        continue;
      }
      const u = age / ev.len;
      const freq = ev.f0 + (ev.f1 - ev.f0) * u;
      const env = Math.sin(Math.PI * Math.min(1, u)) * Math.exp(-u * profile.fall);
      const s = Math.sin(ev.phase) * env * ev.amp;
      ev.phase = advance(ev.phase, (2 * Math.PI * freq) / sampleRate);
      left += s * ev.gl;
      right += s * ev.gr;
    }
    out[0] = left * gain;
    out[1] = right * gain;
    return out;
  };
}

function createForest(layer, mood, rand, sampleRate, total) {
  const leaves = createNoiseBed(
    { ...layer, tone: 0.55 + layer.tone * 0.4 },
    mood,
    rand,
    sampleRate,
  );
  const birds = createChirps(
    layer,
    mood,
    mulberry32(mixSeed((rand() * 1e9) >>> 0, 5)),
    sampleRate,
    total,
    {
      rate: 0.04 + layer.density * 1.3,
      len: [0.07, 0.28],
      f0: (rng, lyr) => 850 + lyr.tone * 1800 + rng() * 1600,
      f1: (rng, lyr) => 600 + lyr.tone * 900 + rng() * 1400,
      amp: [0.18, 0.7],
      gain: 0.55,
      fall: 1.6,
    },
  );
  const out = [0, 0];
  return function forest(i) {
    const leaf = leaves(i);
    const bird = birds(i);
    out[0] = leaf[0] * 0.55 + bird[0];
    out[1] = leaf[1] * 0.55 + bird[1];
    return out;
  };
}

function createOcean(layer, mood, rand, sampleRate) {
  const out = [0, 0];
  const randR = mulberry32(mixSeed((rand() * 1e9) >>> 0, 8));
  let lpL = 0;
  let lpR = 0;
  let ripL = 0;
  let ripR = 0;
  const period = (4.5 + (1 - layer.movement) * 9) / (0.75 + mood * 0.45);
  const swellInc = (2 * Math.PI) / (period * sampleRate);
  let swell = rand() * Math.PI * 2;
  const delayLen = Math.max(8, Math.floor(sampleRate * (0.012 + layer.tone * 0.02)));
  const delay = new Float32Array(delayLen);
  let w = 0;
  const bodyCut = 0.02 + layer.tone * 0.07;
  const rippleCut = 0.08 + layer.tone * 0.35;
  const gain = layer.level * 0.4;
  const foam = 0.15 + layer.density * 0.85;
  return function ocean() {
    const nL = rand() * 2 - 1;
    const nR = randR() * 2 - 1;
    lpL += bodyCut * (nL - lpL);
    lpR += bodyCut * (nR - lpR);
    ripL += rippleCut * (nL - ripL);
    ripR += rippleCut * (nR - ripR);
    const p = (swell % (Math.PI * 2)) / (Math.PI * 2);
    const crest = p < 0.62
      ? Math.sin((p / 0.62) * Math.PI * 0.5)
      : Math.cos(((p - 0.62) / 0.38) * Math.PI * 0.5);
    swell += swellInc;
    const body = 0.25 + 0.75 * crest;
    const left = lpL * body + (nL - ripL) * foam * crest * 0.35;
    delay[w] = left;
    const delayed = delay[(w + Math.floor(delayLen * 0.35)) % delayLen];
    const right = lpR * body * 0.85 + delayed * 0.45 + (nR - ripR) * foam * crest * 0.3;
    w += 1;
    if (w >= delayLen) w = 0;
    out[0] = left * gain;
    out[1] = right * gain;
    return out;
  };
}

function createSwells(layer, mood, rand, sampleRate, total) {
  const out = [0, 0];
  const rate = (0.05 + layer.density * 0.4) * (0.8 + mood * 0.4);
  const events = schedule(rand, rate, total, sampleRate, (rng) => {
    const gains = panGains(rng() * 2 - 1);
    return {
      len: Math.floor(sampleRate * (0.8 + rng() * 1.6)),
      amp: 0.25 + rng() * 0.55,
      gl: gains[0],
      gr: gains[1],
      cut: 0.02 + layer.tone * 0.08,
      lpL: 0,
      lpR: 0,
    };
  });
  let next = 0;
  const active = [];
  return function swells(i) {
    while (next < events.length && events[next].start <= i) {
      active.push(events[next]);
      next += 1;
    }
    let left = 0;
    let right = 0;
    for (let k = active.length - 1; k >= 0; k -= 1) {
      const ev = active[k];
      const age = i - ev.start;
      if (age >= ev.len) {
        active.splice(k, 1);
        continue;
      }
      const env = Math.sin(Math.PI * (age / ev.len)) * ev.amp;
      ev.lpL += ev.cut * ((rand() * 2 - 1) - ev.lpL);
      ev.lpR += ev.cut * ((rand() * 2 - 1) - ev.lpR);
      left += ev.lpL * env * ev.gl;
      right += ev.lpR * env * ev.gr;
    }
    out[0] = left;
    out[1] = right;
    return out;
  };
}

function createCity(layer, mood, rand, sampleRate, total) {
  const out = [0, 0];
  const base = 49 + layer.tone * 62;
  const hum = [];
  const count = 3 + Math.round(layer.density * 3);
  for (let k = 1; k <= count; k += 1) {
    hum.push({
      inc: (2 * Math.PI * base * k * (1 + (rand() - 0.5) * 0.004)) / sampleRate,
      phase: rand() * Math.PI * 2,
      amp: 1 / k,
    });
  }
  const traffic = createSwells(layer, mood, rand, sampleRate, total);
  let rumble = 0;
  const [gl, gr] = panGains((rand() - 0.5) * 0.4);
  const gain = layer.level * 0.22;
  const move = (0.15 + layer.movement * 0.5) / sampleRate;
  let wob = rand() * Math.PI * 2;
  return function city(i) {
    let s = 0;
    const wobble = 0.9 + 0.1 * Math.sin(wob);
    wob += move;
    for (let k = 0; k < hum.length; k += 1) {
      const part = hum[k];
      s += Math.sin(part.phase) * part.amp * wobble;
      part.phase = advance(part.phase, part.inc);
    }
    rumble += (0.02 + layer.tone * 0.05) * ((rand() * 2 - 1) - rumble);
    const pass = traffic(i);
    const mono = (s * 0.55 + rumble * (0.25 + layer.density * 0.45)) * gain;
    out[0] = mono * gl + pass[0] * layer.level * 0.55;
    out[1] = mono * gr + pass[1] * layer.level * 0.55;
    return out;
  };
}

function createSpace(layer, mood, rand, sampleRate, total) {
  const out = [0, 0];
  const f1 = 70 + layer.tone * 280;
  const f2 = f1 * (mood > 0.55 ? 1.498 : 1.5);
  let p1 = rand() * Math.PI * 2;
  let p2 = rand() * Math.PI * 2;
  const beat = 0.03 + layer.movement * 0.35;
  const inc1 = (2 * Math.PI * f1) / sampleRate;
  const inc2 = (2 * Math.PI * (f2 + beat)) / sampleRate;
  const pings = createChirps(layer, mood, rand, sampleRate, total, {
    rate: 0.03 + layer.density * 0.7,
    len: [0.4, 1.8],
    f0: (rng, lyr) => 1600 + lyr.tone * 2800 + rng() * 1800,
    f1: (rng, lyr) => 1400 + lyr.tone * 2000 + rng() * 900,
    amp: [0.08, 0.28],
    gain: 0.7,
    fall: 2.4,
  });
  let air = 0;
  const gain = layer.level * 0.24;
  return function space(i) {
    const s = Math.sin(p1) * 0.7 + Math.sin(p2) * 0.45;
    p1 = advance(p1, inc1);
    p2 = advance(p2, inc2);
    air += 0.012 * ((rand() * 2 - 1) - air);
    const ping = pings(i);
    out[0] = (s + air * 0.45) * gain + ping[0];
    out[1] = (s * 0.82 + air * 0.6) * gain + ping[1];
    return out;
  };
}

function createDread(layer, mood, rand, sampleRate, total) {
  const out = [0, 0];
  const base = 34 + layer.tone * 28;
  const ratios = [1, 1.059, 1.414, 1.498, 2.01];
  const cluster = [];
  for (let i = 0; i < ratios.length; i += 1) {
    cluster.push({
      inc: (2 * Math.PI * base * ratios[i] * (1 + (rand() - 0.5) * 0.006)) / sampleRate,
      phase: rand() * Math.PI * 2,
      amp: i === 0 ? 1 : 0.28 + layer.density * 0.15,
    });
  }
  const pulseInc = (2 * Math.PI * (0.25 + layer.movement * 1.5) * (0.7 + mood * 0.8)) / sampleRate;
  let pulse = rand() * Math.PI * 2;
  let sub = rand() * Math.PI * 2;
  const subInc = (2 * Math.PI * (base * 0.5)) / sampleRate;
  const ticks = createChirps(layer, mood, rand, sampleRate, total, {
    rate: 0.05 + layer.density * 0.9,
    len: [0.05, 0.22],
    f0: (rng, lyr) => (180 + lyr.tone * 220) * (1 + rng()),
    f1: (rng, lyr) => (260 + lyr.tone * 400) * (2.2 + rng()),
    amp: [0.12, 0.4],
    gain: 0.45 + mood * 0.25,
    fall: 3,
  });
  const gain = layer.level * 0.26;
  const [gl, gr] = panGains((rand() - 0.5) * 0.5);
  const sharp = 3 + mood * 4;
  return function dread(i) {
    let s = 0;
    for (let n = 0; n < cluster.length; n += 1) {
      const part = cluster[n];
      s += Math.sin(part.phase) * part.amp;
      part.phase = advance(part.phase, part.inc);
    }
    const env = (0.5 + 0.5 * Math.sin(pulse)) ** sharp;
    pulse = advance(pulse, pulseInc);
    const heart = Math.sin(sub) * env;
    sub = advance(sub, subInc);
    const tick = ticks(i);
    const mono = Math.tanh((s * 0.45 + heart * 1.3) * (1 + mood * 0.4)) * gain;
    out[0] = mono * gl + tick[0];
    out[1] = mono * gr + tick[1];
    return out;
  };
}

const BUILDERS = {
  drone: (layer, mood, rand, sampleRate) => createDrone(layer, mood, rand, sampleRate),
  rain: (layer, mood, rand, sampleRate, total) => createRain(layer, mood, rand, sampleRate, total),
  wind: (layer, mood, rand, sampleRate) => createNoiseBed(layer, mood, rand, sampleRate),
  cave: (layer, mood, rand, sampleRate, total) => createCave(layer, mood, rand, sampleRate, total),
  forest: (layer, mood, rand, sampleRate, total) => createForest(layer, mood, rand, sampleRate, total),
  ocean: (layer, mood, rand, sampleRate) => createOcean(layer, mood, rand, sampleRate),
  city: (layer, mood, rand, sampleRate, total) => createCity(layer, mood, rand, sampleRate, total),
  space: (layer, mood, rand, sampleRate, total) => createSpace(layer, mood, rand, sampleRate, total),
  dread: (layer, mood, rand, sampleRate, total) => createDread(layer, mood, rand, sampleRate, total),
};

function softClip(sample, mood) {
  const x = sample * (1.05 + mood * 0.45);
  return x / (1 + Math.abs(x));
}

/**
 * Render a seamless stereo ambience loop.
 *
 * `layers` is either an array of `{ kind, level, tone, movement, density }`
 * or a spec `{ mood, layers }`. Mood runs from 0 (calm) to 1 (tense).
 * At most six layers are heard. `seed` may be a number or a string.
 */
export function renderAmbience(layers, seconds, seed) {
  const length = Number(seconds);
  if (!Number.isFinite(length) || length <= 0) {
    throw new RangeError("seconds must be a positive finite number");
  }
  if (length > MAX_SECONDS) {
    throw new RangeError("seconds must be " + MAX_SECONDS + " or less");
  }
  const spec = normalizeSpec(layers);
  const seedU = hashSeed(seed);
  const sampleCount = Math.max(1, Math.round(length * SAMPLE_RATE));
  const fade = Math.min(Math.floor(SAMPLE_RATE * 0.2), Math.floor(sampleCount / 3));
  const total = sampleCount + Math.max(fade, 1);
  const mood = spec.mood;
  const moveScale = 0.55 + mood * 0.9;
  const voices = [];
  for (let i = 0; i < spec.layers.length; i += 1) {
    const layer = spec.layers[i];
    if (layer.level <= 0) continue;
    const shaped = {
      kind: layer.kind,
      level: layer.level,
      tone: layer.tone,
      movement: clamp01(layer.movement * moveScale, 0),
      density: clamp01(layer.density * (0.8 + mood * 0.45), 0),
    };
    const rand = mulberry32(mixSeed(seedU, i + 1));
    voices.push(BUILDERS[shaped.kind](shaped, mood, rand, SAMPLE_RATE, total));
  }

  const tempL = new Float32Array(total);
  const tempR = new Float32Array(total);
  let prevL = 0;
  let prevR = 0;
  let dcL = 0;
  let dcR = 0;
  let dullL = 0;
  let dullR = 0;
  const dull = 0.05 + (1 - mood) * 0.12;
  const bright = 0.55 + mood * 0.9;
  const dullMix = 1.15 - mood * 0.4;
  const dc = 0.996;

  for (let i = 0; i < total; i += 1) {
    let l = 0;
    let r = 0;
    for (let v = 0; v < voices.length; v += 1) {
      const pair = voices[v](i);
      l += pair[0];
      r += pair[1];
    }
    dullL += dull * (l - dullL);
    dullR += dull * (r - dullR);
    l = dullL * dullMix + (l - dullL) * bright;
    r = dullR * dullMix + (r - dullR) * bright;
    const yL = l - prevL + dc * dcL;
    const yR = r - prevR + dc * dcR;
    prevL = l;
    prevR = r;
    dcL = yL;
    dcR = yR;
    tempL[i] = softClip(yL, mood);
    tempR[i] = softClip(yR, mood);
  }

  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  if (fade >= 8) {
    for (let i = 0; i < sampleCount; i += 1) {
      if (i < fade) {
        const t = i / fade;
        const wTail = Math.cos(t * Math.PI * 0.5);
        const wHead = Math.sin(t * Math.PI * 0.5);
        left[i] = tempL[sampleCount + i] * wTail + tempL[i] * wHead;
        right[i] = tempR[sampleCount + i] * wTail + tempR[i] * wHead;
      } else {
        left[i] = tempL[i];
        right[i] = tempR[i];
      }
    }
  } else {
    left.set(tempL.subarray(0, sampleCount));
    right.set(tempR.subarray(0, sampleCount));
  }

  let peak = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const a = left[i] < 0 ? -left[i] : left[i];
    const b = right[i] < 0 ? -right[i] : right[i];
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < sampleCount; i += 1) {
      left[i] *= g;
      right[i] *= g;
    }
  }

  return {
    sampleRate: SAMPLE_RATE,
    sampleCount,
    seconds: sampleCount / SAMPLE_RATE,
    seed: seedU,
    mood,
    layers: spec.layers,
    left,
    right,
  };
}
