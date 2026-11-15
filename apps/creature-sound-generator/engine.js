// Atelier Instruments — MIT License
// Offline creature vocalizer. No DOM, no Web Audio — pure PCM so tests and
// batch export can render without a browser. The UI plays the buffer back.

export const SAMPLE_RATE = 44100;
export const SPECIES = ["beast", "bird", "insect", "robot", "slime"];
export const MOODS = ["happy", "angry", "scared", "sleepy"];
export const GESTURES = ["idle", "attack", "hurt", "death", "talk"];

const VOWEL = {
  a: [1, 1, 1],
  e: [0.62, 1.45, 1.1],
  i: [0.48, 1.72, 1.22],
  o: [0.78, 0.7, 0.86],
  u: [0.5, 0.58, 0.72],
};

// Source mix, formants and motion for each species. Numeric so neighbors morph.
const PROFILES = [
  {
    f0: 92, pulse: 1, sine: 0.26, buzz: 0.05, square: 0, bubble: 0.05,
    noise: 0.15, f1: 440, f2: 1020, f3: 2350, q: 4.6, growl: 0.84, purr: 0.18,
    quant: 0, crush: 0, bright: 0.3, vib: 0.12, jitter: 0.04, harm2: 0.42,
    buzzRatio: 2.5, ring: 0, click: 0.1, sub: 0.62,
  },
  {
    f0: 1580, pulse: 0.02, sine: 1, buzz: 0.05, square: 0, bubble: 0,
    noise: 0.04, f1: 1550, f2: 2850, f3: 4400, q: 7.2, growl: 0, purr: 0,
    quant: 0, crush: 0, bright: 0.96, vib: 0.46, jitter: 0.02, harm2: 0.2,
    buzzRatio: 2, ring: 0, click: 0.02, sub: 0,
  },
  {
    f0: 142, pulse: 0.1, sine: 0.12, buzz: 1, square: 0.16, bubble: 0,
    noise: 0.22, f1: 2000, f2: 3500, f3: 5200, q: 6.4, growl: 0.16, purr: 0,
    quant: 0.12, crush: 0.06, bright: 0.8, vib: 0.08, jitter: 0.08, harm2: 0.04,
    buzzRatio: 13, ring: 0.08, click: 0.95, sub: 0,
  },
  {
    f0: 208, pulse: 0.04, sine: 0.16, square: 1, buzz: 0.14, bubble: 0,
    noise: 0.07, f1: 640, f2: 1500, f3: 3000, q: 9, growl: 0.04, purr: 0,
    quant: 1, crush: 0.52, bright: 0.52, vib: 0.02, jitter: 0.01, harm2: 0.02,
    buzzRatio: 3.2, ring: 0.88, click: 0.28, sub: 0.12,
  },
  {
    f0: 60, pulse: 0.22, sine: 0.9, buzz: 0.05, square: 0, bubble: 1,
    noise: 0.24, f1: 250, f2: 560, f3: 1250, q: 2.5, growl: 0.08, purr: 0.38,
    quant: 0, crush: 0, bright: 0.14, vib: 0.28, jitter: 0.11, harm2: 0.05,
    buzzRatio: 2, ring: 0, click: 0.05, sub: 0.34,
  },
];

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampFreq(freq) {
  if (!Number.isFinite(freq)) return 110;
  if (freq < 28) return 28;
  const limit = SAMPLE_RATE * 0.45;
  if (freq > limit) return limit;
  return freq;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashUnit(n) {
  let x = Math.imul((n ^ (n >>> 16)) >>> 0, 0x7feb352d);
  x = Math.imul((x ^ (x >>> 15)) >>> 0, 0x846ca68b);
  return (((x ^ (x >>> 16)) >>> 0) / 4294967296);
}

function hashSigned(n) {
  return hashUnit(n) * 2 - 1;
}

function weights(value, count) {
  const x = clamp01(value) * (count - 1);
  const out = new Array(count).fill(0);
  if (x >= count - 1) {
    out[count - 1] = 1;
    return out;
  }
  const i = Math.floor(x);
  const f = x - i;
  out[i] = 1 - f;
  out[i + 1] = f;
  return out;
}

function blendProfiles(speciesWeights) {
  const keys = Object.keys(PROFILES[0]);
  const out = {};
  for (const key of keys) {
    let sum = 0;
    for (let i = 0; i < PROFILES.length; i++) sum += speciesWeights[i] * PROFILES[i][key];
    out[key] = sum;
  }
  return out;
}

function polyblep(t, dt) {
  if (dt <= 0) return 0;
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

function designBiquad(type, sampleRate, freq, q, gainDb = 0) {
  const f = Math.min(Math.max(40, freq), sampleRate * 0.45);
  const Q = Math.max(0.25, q);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === "peak") {
    const A = 10 ** (gainDb / 40);
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else if (type === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function makeFilter(coeff) {
  const [b0, b1, b2, a1, a2] = coeff;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    if (!Number.isFinite(y)) {
      x1 = 0;
      x2 = 0;
      y1 = 0;
      y2 = 0;
      return 0;
    }
    return y;
  };
}

function pickVowel(rng, speciesW) {
  const roll = rng();
  if (speciesW[1] > 0.45) return roll < 0.65 ? "i" : "e";
  if (speciesW[4] > 0.45) return roll < 0.55 ? "u" : "o";
  if (speciesW[2] > 0.45) return roll < 0.7 ? "i" : "e";
  if (speciesW[3] > 0.45) return roll < 0.5 ? "a" : "e";
  return roll < 0.62 ? "a" : "o";
}

function syllable(t, dur, f0a, f0b, amp, extra = {}) {
  return {
    t,
    dur: Math.max(0.035, dur),
    f0a,
    f0b,
    amp,
    noise: extra.noise ?? 0,
    vowel: extra.vowel ?? "a",
    vib: extra.vib ?? 1,
    attack: extra.attack ?? 0.012,
    release: extra.release ?? 0.04,
  };
}

function planGesture(gesture, profile, speciesW, moodW, rng) {
  const happy = moodW[0];
  const angry = moodW[1];
  const scared = moodW[2];
  const sleepy = moodW[3];
  const bird = speciesW[1];
  const insect = speciesW[2];
  const slime = speciesW[4];
  const pace = profile.durMul * (1 - bird * 0.38 - insect * 0.18 + slime * 0.24);
  const jitter = 0.06 + scared * 0.12;
  const syllables = [];
  const events = [];

  const scaleTime = (seconds) => seconds * pace;
  const vary = (amount) => 1 + (rng() * 2 - 1) * amount;

  if (gesture === "idle") {
    const count = 1 + (rng() < 0.35 + bird * 0.45 ? 1 : 0) + (rng() < insect * 0.55 ? 1 : 0);
    let t = 0.02;
    for (let i = 0; i < count; i++) {
      const dur = (0.14 + rng() * 0.16) * (bird > 0.5 ? 0.62 : 1) * (0.85 + sleepy * 0.6);
      const f0a = (0.9 + rng() * 0.12) * vary(jitter);
      const sweep = 1 + bird * 0.5 + happy * 0.16 - (1 - bird) * 0.14 + slime * 0.08;
      syllables.push(syllable(t, dur, f0a, f0a * sweep, 0.32 + rng() * 0.12 + sleepy * 0.08, {
        vowel: pickVowel(rng, speciesW),
        attack: 0.028 + sleepy * 0.06,
        release: 0.07 + sleepy * 0.08,
        noise: 0.04 + angry * 0.08,
        vib: 0.6 + scared * 0.8,
      }));
      t += dur + 0.05 + rng() * 0.07 + sleepy * 0.04;
    }
  } else if (gesture === "attack") {
    const f0a = (1.18 + happy * 0.22 + scared * 0.38 + bird * 0.28) * vary(jitter * 0.8);
    const f0b = 0.64 - angry * 0.16 + bird * 0.18;
    syllables.push(syllable(0.004, 0.15 + rng() * 0.08, f0a, f0b, 1, {
      vowel: angry > scared ? "a" : "e",
      attack: 0.003,
      release: 0.045,
      noise: 0.22 + angry * 0.2,
      vib: 0.35,
    }));
    if (rng() < 0.78) {
      const t = 0.16 + rng() * 0.05;
      syllables.push(syllable(t, 0.07 + rng() * 0.05, f0a * 1.18, f0b * 0.92, 0.78, {
        vowel: "i",
        attack: 0.002,
        release: 0.03,
        noise: 0.32,
        vib: 0.2,
      }));
    }
    events.push({ type: "impact", t: 0, amp: 0.85, freq: 220 + (1 - profile.size) * 700, decay: 48 });
    events.push({ type: "thump", t: 0, amp: 0.45 + speciesW[0] * 0.55, freq: 48 + (1 - profile.size) * 40, decay: 26 });
  } else if (gesture === "hurt") {
    syllables.push(syllable(0.002, 0.08 + rng() * 0.03, 1.05 * vary(jitter), 1.72 + scared * 0.25, 0.88, {
      vowel: "i",
      attack: 0.002,
      release: 0.02,
      noise: 0.12,
      vib: 0.4,
    }));
    syllables.push(syllable(0.1, 0.26 + rng() * 0.12, 1.42, 0.68 - angry * 0.1, 0.72, {
      vowel: "e",
      attack: 0.01,
      release: 0.08,
      noise: 0.14 + scared * 0.1,
      vib: 1.5 + scared,
    }));
    if (rng() < 0.62) {
      syllables.push(syllable(0.4 + rng() * 0.05, 0.22 + sleepy * 0.1, 0.9, 0.48, 0.42, {
        vowel: "u",
        attack: 0.02,
        release: 0.1,
        noise: 0.16,
        vib: 1.7,
      }));
    }
    events.push({ type: "impact", t: 0, amp: 0.32, freq: 1600 + rng() * 400, decay: 180 });
  } else if (gesture === "death") {
    syllables.push(syllable(0.02, 0.85 + rng() * 0.25, 1.22 * vary(0.04), 0.52, 0.92, {
      vowel: pickVowel(rng, speciesW),
      attack: 0.03 + sleepy * 0.04,
      release: 0.18,
      noise: 0.08,
      vib: 0.8 + scared * 0.6,
    }));
    syllables.push(syllable(0.72, 0.7 + rng() * 0.3, 0.62, 0.3, 0.55, {
      vowel: "u",
      attack: 0.06,
      release: 0.28,
      noise: 0.22,
      vib: 0.5,
    }));
    events.push({
      type: "air",
      t: 0.85,
      dur: 0.85,
      amp: 0.22 + profile.noise * 0.35,
    });
  } else {
    const scales = [
      [0, 2, 4, 7, 9],
      [0, 1, 3, 6, 10],
      [0, 1, 5, 6, 11],
      [0, 2, 3, 7, 10],
    ];
    let scale = scales[0];
    let best = happy;
    if (angry > best) {
      scale = scales[1];
      best = angry;
    }
    if (scared > best) {
      scale = scales[2];
      best = scared;
    }
    if (sleepy > best) scale = scales[3];
    const count = 4 + Math.floor(rng() * 4);
    const vowels = ["a", "e", "o", "u", "i", "e", "a"];
    let degree = Math.floor(rng() * scale.length);
    let t = 0.02;
    for (let i = 0; i < count; i++) {
      const step = rng() < 0.5 ? -1 : 1;
      degree = Math.max(0, Math.min(scale.length - 1, degree + step + (angry > 0.6 && rng() < 0.35 ? -1 : 0)));
      if (scared > 0.55 && rng() < 0.4) degree = Math.floor(rng() * scale.length);
      const semis = scale[degree];
      const mul = 2 ** (semis / 12) * (0.9 + rng() * 0.08);
      const dur = (0.07 + rng() * 0.08 + sleepy * 0.06) * (bird > 0.5 ? 0.75 : 1);
      const gap = Math.max(0.018, 0.03 + rng() * 0.045 + sleepy * 0.05 - angry * 0.012 + (scared > 0.5 && rng() < 0.3 ? 0.07 : 0));
      const endMul = mul * (1 + happy * 0.05 - angry * 0.07);
      syllables.push(syllable(t, dur, mul, endMul, 0.5 + rng() * 0.28, {
        vowel: vowels[i % vowels.length],
        attack: 0.006,
        release: 0.028,
        noise: 0.06 + (rng() < 0.45 ? 0.18 : 0),
        vib: 0.45 + scared * 0.4,
      }));
      t += dur + gap;
    }
  }

  for (const syl of syllables) {
    syl.t = scaleTime(syl.t);
    syl.dur = Math.max(0.03, scaleTime(syl.dur));
  }
  for (const event of events) {
    event.t = scaleTime(event.t);
    if (event.dur) event.dur = scaleTime(event.dur);
  }

  const clickCount = Math.round(profile.click * (gesture === "talk" ? 7 : gesture === "idle" ? 3 : 5) * (0.45 + rng()));
  let endGuess = 0.2;
  for (const syl of syllables) endGuess = Math.max(endGuess, syl.t + syl.dur);
  for (let i = 0; i < clickCount; i++) {
    events.push({
      type: "click",
      t: rng() * endGuess * 0.92,
      amp: 0.12 + rng() * 0.28,
      freq: 1400 + rng() * 2800,
      decay: 280 + rng() * 360,
    });
  }
  const bubbleCount = Math.round(profile.bubble * (5 + rng() * 7));
  for (let i = 0; i < bubbleCount; i++) {
    events.push({
      type: "bubble",
      t: rng() * Math.max(0.05, endGuess - 0.02),
      amp: 0.28 + rng() * 0.5,
      freq: 90 + rng() * 540,
      decay: 7 + rng() * 12,
    });
  }

  let end = 0.12;
  for (const syl of syllables) end = Math.max(end, syl.t + syl.dur);
  for (const event of events) end = Math.max(end, event.t + (event.dur || 0.08));
  end += gesture === "death" ? 0.18 : 0.05;
  end = Math.min(3.5, Math.max(0.12, end));
  return { syllables, events, duration: end };
}

function renderSyllable(buffer, syl, profile, sampleRate, seed, salt) {
  const start = Math.max(0, Math.floor(syl.t * sampleRate));
  const len = Math.max(1, Math.floor(syl.dur * sampleRate));
  const vowel = VOWEL[syl.vowel] || VOWEL.a;
  const peakGain = 5.5 + profile.bright * 9;
  const f1 = makeFilter(designBiquad("peak", sampleRate, profile.f1 * vowel[0], profile.q, peakGain));
  const f2 = makeFilter(designBiquad("peak", sampleRate, profile.f2 * vowel[1], profile.q * 0.9, peakGain * 0.85));
  const f3 = makeFilter(designBiquad("peak", sampleRate, profile.f3 * vowel[2], profile.q * 0.75, peakGain * 0.5));
  const noiseHP = makeFilter(designBiquad("highpass", sampleRate, 800, 0.7));

  let phase = hashUnit(salt + 3);
  let phase2 = hashUnit(salt + 9);
  let subPhase = hashUnit(salt + 11);
  let carrierPhase = hashUnit(salt + 13);
  let buzzPhase = 0;
  let ringPhase = hashUnit(salt + 19);
  let growlPhase = hashUnit(salt + 23);
  let purrPhase = hashUnit(salt + 29);
  let chatterPhase = 0;
  const hop = Math.max(1, Math.round(sampleRate * (0.028 + (1 - profile.quant) * 0.05)));
  let stepIndex = -1;
  let stepF0 = profile.f0;
  const attack = Math.max(0.001, syl.attack);
  const release = Math.max(0.001, syl.release);

  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= buffer.length) break;
    const u = i / sampleRate;
    const pos = len <= 1 ? 1 : i / (len - 1);
    const shaped = pos * pos * (3 - 2 * pos);
    let env;
    if (u < attack) env = u / attack;
    else if (u > syl.dur - release) env = Math.max(0, (syl.dur - u) / release);
    else env = 1;
    env = Math.max(0, Math.min(1, env));

    const si = Math.floor(i / hop);
    if (si !== stepIndex) {
      stepIndex = si;
      const target = profile.f0 * (syl.f0a + (syl.f0b - syl.f0a) * shaped);
      const wobble = 1 + Math.sin(2 * Math.PI * (2.1 + profile.bubble * 2.4) * (syl.t + u)) * profile.bubble * 0.16;
      const vibRate = 4.1 + profile.vib * 6.8;
      const vib = 1 + Math.sin(2 * Math.PI * vibRate * (syl.t + u)) * (0.004 + profile.vib * 0.02) * syl.vib;
      const jit = 1 + (hashUnit(salt + si * 17) - 0.5) * profile.jitter * 0.16;
      let f = target * wobble * vib * jit;
      if (profile.quant > 0.05) {
        const semis = Math.round(12 * Math.log2(Math.max(30, f) / 55));
        const snapped = 55 * 2 ** (semis / 12);
        f = f * (1 - profile.quant) + snapped * profile.quant;
      }
      stepF0 = clampFreq(f);
    }

    const dt = stepF0 / sampleRate;
    phase += dt;
    if (phase >= 1) phase -= 1;
    phase2 += dt * 2;
    if (phase2 >= 1) phase2 -= 1;
    subPhase += dt * 0.5;
    if (subPhase >= 1) subPhase -= 1;

    const oq = 0.32 + (1 - Math.min(1, profile.growl)) * 0.28;
    let pulse = 0;
    if (phase < oq) pulse = Math.sin((Math.PI * phase) / oq);
    const edge = Math.max(0, 1 - Math.abs(phase - oq) / 0.018);
    pulse += edge * 0.4;

    const sine = Math.sin(2 * Math.PI * phase);
    const harm2 = Math.sin(2 * Math.PI * phase2);
    const sub = Math.sin(2 * Math.PI * subPhase);
    let square = phase < 0.5 ? 1 : -1;
    square += polyblep(phase, dt);
    const phaseHalf = phase + 0.5 >= 1 ? phase - 0.5 : phase + 0.5;
    square -= polyblep(phaseHalf, dt);

    buzzPhase += dt;
    if (buzzPhase >= 1) buzzPhase -= 1;
    carrierPhase += dt * profile.buzzRatio;
    if (carrierPhase >= 1) carrierPhase -= 1;
    const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * buzzPhase);
    const buzz = Math.sin(2 * Math.PI * carrierPhase) * (0.18 + 0.82 * am * am);

    ringPhase += dt * (1.51 + profile.ring);
    if (ringPhase >= 1) ringPhase -= 1;

    let src =
      pulse * profile.pulse +
      sine * profile.sine +
      harm2 * profile.harm2 * 0.45 +
      square * profile.square * 0.55 +
      buzz * profile.buzz * 0.9 +
      sub * profile.sub * 0.75;

    if (profile.ring > 0.05) {
      const ring = Math.sin(2 * Math.PI * ringPhase);
      src *= 1 - profile.ring * 0.45 + profile.ring * ring * 0.85;
    }

    const voiced = f3(f2(f1(src)));
    const dry = Math.max(profile.sine, profile.square, profile.buzz);
    let y = voiced * (0.42 + profile.pulse * 0.45) + src * (0.32 + dry * 0.42);

    const noise = noiseHP(hashSigned(idx * 13 + salt * 7 + seed));
    const consonant = u < 0.016 ? 1 - u / 0.016 : 0;
    y += noise * (profile.noise * 0.5 * (0.3 + 0.7 * env) + syl.noise * (0.35 + consonant));

    growlPhase += (20 + profile.growl * 30) / sampleRate;
    purrPhase += (4.2 + profile.purr * 3.2) / sampleRate;
    chatterPhase += (26 + profile.buzz * 70) / sampleRate;
    const growlAm = 1 - profile.growl * 0.5 * (0.5 - 0.5 * Math.sin(2 * Math.PI * growlPhase));
    const purrAm = 1 - profile.purr * 0.64 * (0.5 - 0.5 * Math.sin(2 * Math.PI * purrPhase));
    const chatterAm = 1 - Math.min(0.72, profile.buzz * 0.58) * (0.5 - 0.5 * Math.sin(2 * Math.PI * chatterPhase));
    y *= growlAm * purrAm * chatterAm * env * syl.amp;
    buffer[idx] += y;
  }
}

function renderEvents(buffer, events, sampleRate, seed) {
  for (let eIndex = 0; eIndex < events.length; eIndex++) {
    const event = events[eIndex];
    const start = Math.floor(event.t * sampleRate);
    if (event.type === "bubble") {
      const len = Math.floor(0.3 * sampleRate);
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= buffer.length) continue;
        const u = i / sampleRate;
        const env = Math.exp(-u * event.decay);
        const freq = event.freq * Math.exp(-u * event.decay * 0.55);
        phase += freq / sampleRate;
        const wob = 1 + 0.07 * Math.sin(2 * Math.PI * 20 * u);
        buffer[idx] += Math.sin(2 * Math.PI * phase) * env * event.amp * wob;
        if (i < 10) buffer[idx] += hashSigned(idx + seed + eIndex * 19) * (1 - i / 10) * event.amp * 0.25;
      }
    } else if (event.type === "thump") {
      const len = Math.floor(0.12 * sampleRate);
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= buffer.length) continue;
        const u = i / sampleRate;
        phase += event.freq / sampleRate;
        buffer[idx] += Math.sin(2 * Math.PI * phase) * Math.exp(-u * event.decay) * event.amp;
      }
    } else if (event.type === "air") {
      const len = Math.max(1, Math.floor(event.dur * sampleRate));
      const hp = makeFilter(designBiquad("highpass", sampleRate, 500, 0.7));
      const lp = makeFilter(designBiquad("lowpass", sampleRate, 1600, 0.7));
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= buffer.length) continue;
        const u = i / len;
        const env = Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - u);
        buffer[idx] += lp(hp(hashSigned(idx * 5 + seed + eIndex))) * env * event.amp * 1.5;
      }
    } else {
      const dur = event.type === "impact" ? 0.085 : 0.022;
      const len = Math.floor(dur * sampleRate);
      const bp = makeFilter(designBiquad("bandpass", sampleRate, event.freq, event.type === "impact" ? 1.1 : 3.2));
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= buffer.length) continue;
        const u = i / sampleRate;
        const env = Math.exp(-u * event.decay);
        phase += (event.freq * Math.exp(-u * (event.type === "impact" ? 12 : 40))) / sampleRate;
        const noise = hashSigned(idx * 3 + seed + eIndex * 131);
        const sig = noise * 0.85 + Math.sin(2 * Math.PI * phase) * (event.type === "impact" ? 0.65 : 0.12);
        buffer[idx] += bp(sig) * env * event.amp * 2.4;
      }
    }
  }
}

function master(buffer, profile, sampleRate, velocity) {
  const fc = clampFreq(800 + profile.bright * 12000);
  const k = 1 - Math.exp((-2 * Math.PI * Math.min(fc, 16000)) / sampleRate);
  let low = 0;
  const holdN = profile.crush < 0.08 ? 1 : 1 + Math.round(profile.crush * 16);
  let held = 0;
  let holdLeft = 0;
  const drive = 1 + profile.drive * 3.1;
  let prevX = 0;
  let prevY = 0;
  const r = 0.995;
  for (let i = 0; i < buffer.length; i++) {
    let x = buffer[i];
    low += k * (x - low);
    x = low;
    if (holdN > 1) {
      if (holdLeft <= 0) {
        held = x;
        holdLeft = holdN;
      }
      holdLeft -= 1;
      x = held;
    }
    x = Math.tanh(x * drive);
    const y = x - prevX + r * prevY;
    prevX = x;
    prevY = y;
    buffer[i] = Number.isFinite(y) ? y : 0;
  }

  const fadeIn = Math.max(1, Math.floor(sampleRate * 0.004));
  const fadeOut = Math.max(1, Math.floor(sampleRate * 0.016));
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    let gain = 1;
    if (i < fadeIn) gain = i / fadeIn;
    const tail = buffer.length - 1 - i;
    if (tail < fadeOut) gain *= Math.max(0, tail / fadeOut);
    buffer[i] *= gain;
    const mag = Math.abs(buffer[i]);
    if (mag > peak) peak = mag;
  }
  const target = 0.22 + 0.67 * clamp01(velocity, 1);
  const gain = peak > 1e-5 ? target / peak : 0;
  for (let i = 0; i < buffer.length; i++) {
    let y = buffer[i] * gain;
    if (y > 1) y = 1;
    else if (y < -1) y = -1;
    buffer[i] = y;
  }
}

function normalizeParams(params, seed) {
  const source = params && typeof params === "object" ? params : {};
  const gesture = String(source.gesture || "idle").toLowerCase().trim();
  let numericSeed = Number(seed);
  if (!Number.isFinite(numericSeed)) numericSeed = 1;
  return {
    size: clamp01(source.size, 0.5),
    mood: clamp01(source.mood, 0),
    species: clamp01(source.species, 0),
    roughness: clamp01(source.roughness, 0.25),
    velocity: clamp01(source.velocity ?? 1, 1),
    gesture: GESTURES.includes(gesture) ? gesture : "idle",
    seed: numericSeed >>> 0,
  };
}

function shapeProfile(params) {
  const speciesW = weights(params.species, SPECIES.length);
  const moodW = weights(params.mood, MOODS.length);
  const profile = blendProfiles(speciesW);
  const happy = moodW[0];
  const angry = moodW[1];
  const scared = moodW[2];
  const sleepy = moodW[3];
  const sizeMul = 2 ** ((0.5 - params.size) * 2.55);
  const formMul = 2 ** ((0.5 - params.size) * 1.22);
  profile.f0 = clampFreq(profile.f0 * sizeMul * (happy * 1.14 + angry * 0.84 + scared * 1.3 + sleepy * 0.74));
  profile.f1 = clampFreq(profile.f1 * formMul);
  profile.f2 = clampFreq(profile.f2 * formMul * (1 + happy * 0.08 + scared * 0.05 - sleepy * 0.12));
  profile.f3 = clampFreq(profile.f3 * formMul);
  profile.noise = clamp01(profile.noise + angry * 0.22 + scared * 0.1 + params.roughness * 0.36 - sleepy * 0.04 - happy * 0.03);
  profile.bright = clamp01(profile.bright + happy * 0.16 + scared * 0.08 - sleepy * 0.22 - angry * 0.05 + params.roughness * 0.06);
  profile.growl = clamp01(profile.growl + angry * 0.3 + params.roughness * 0.34 - happy * 0.16 - sleepy * 0.22);
  profile.purr = clamp01(profile.purr + sleepy * 0.78 - angry * 0.12);
  profile.vib = clamp01(profile.vib + scared * 0.5 + happy * 0.08);
  profile.jitter = clamp01(profile.jitter + scared * 0.16 + params.roughness * 0.2 + angry * 0.05);
  profile.crush = clamp01(profile.crush + params.roughness * 0.7);
  profile.drive = angry * 0.9 + params.roughness * 0.8 + scared * 0.18 + happy * 0.1;
  profile.durMul = (0.58 + params.size * 1.15) * (1 + sleepy * 0.26 - angry * 0.08);
  profile.size = params.size;
  return { profile, speciesW, moodW };
}

/**
 * Render one creature vocalization.
 * @param {object} params
 * @param {number} [params.size] 0 tiny → 1 huge
 * @param {number} [params.mood] 0 happy → angry → scared → 1 sleepy
 * @param {number} [params.species] 0 beast → bird → insect → robot → 1 slime
 * @param {number} [params.roughness] 0 smooth → 1 harsh
 * @param {string} [params.gesture] idle | attack | hurt | death | talk
 * @param {number} [params.velocity] 0..1 output level, after the voice is shaped
 * @param {number} seed deterministic variation
 * @returns {{
 *   sampleRate: number,
 *   samples: Float32Array,
 *   duration: number,
 *   gesture: string,
 *   speciesName: string,
 *   moodName: string,
 *   seed: number,
 *   params: { size: number, mood: number, species: number, roughness: number, gesture: string, velocity: number }
 * }}
 */
export function renderCreature(params = {}, seed = 1) {
  const clean = normalizeParams(params, seed);
  const { profile, speciesW, moodW } = shapeProfile(clean);
  const rng = mulberry32(clean.seed);
  const plan = planGesture(clean.gesture, profile, speciesW, moodW, rng);
  const samples = new Float32Array(Math.max(1, Math.floor(plan.duration * SAMPLE_RATE)));
  plan.syllables.forEach((syl, index) => {
    renderSyllable(samples, syl, profile, SAMPLE_RATE, clean.seed, (clean.seed + 1) * (index + 3) * 97);
  });
  renderEvents(samples, plan.events, SAMPLE_RATE, clean.seed);
  master(samples, profile, SAMPLE_RATE, clean.velocity);
  return {
    sampleRate: SAMPLE_RATE,
    samples,
    duration: samples.length / SAMPLE_RATE,
    gesture: clean.gesture,
    speciesName: nearestLabel(clean.species, SPECIES),
    moodName: nearestLabel(clean.mood, MOODS),
    seed: clean.seed,
    params: {
      size: clean.size,
      mood: clean.mood,
      species: clean.species,
      roughness: clean.roughness,
      gesture: clean.gesture,
      velocity: clean.velocity,
    },
  };
}

export function nearestLabel(value, labels) {
  const x = clamp01(value) * (labels.length - 1);
  return labels[Math.round(x)];
}

export function blendLabel(value, labels) {
  const x = clamp01(value) * (labels.length - 1);
  if (x >= labels.length - 1) return labels[labels.length - 1].toUpperCase();
  const i = Math.floor(x);
  const f = x - i;
  if (f < 0.18) return labels[i].toUpperCase();
  if (f > 0.82) return labels[i + 1].toUpperCase();
  return `${labels[i].toUpperCase()} → ${labels[i + 1].toUpperCase()}`;
}

export function sizeLabel(size) {
  const value = clamp01(size, 0.5);
  if (value < 0.16) return "TINY";
  if (value < 0.36) return "SMALL";
  if (value < 0.62) return "MEDIUM";
  if (value < 0.82) return "LARGE";
  return "HUGE";
}
