// SPDX-License-Identifier: MIT
// Sidechain pump + filter sweep. Pure math: no DOM, no Web Audio nodes.
// Live playback imports the same curves so the bounce matches what you hear.

export const RATES = ["1/1", "1/2", "1/4", "1/8", "1/16", "1/4T", "1/8T", "1/16T"];

const RATE_BEATS = {
  "1/1": 4,
  "1/2": 2,
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/4T": 2 / 3,
  "1/8T": 1 / 3,
  "1/16T": 1 / 6,
};

const RANK = { build: 1, drop: 2, cut: 3 };
const RELEASE = { build: 0.08, drop: 0.08, cut: 0.012 };

const sceneScratch = {
  cutoff: 14000,
  resonance: 0.2,
  gain: 1,
  riser: 0,
  riserFreq: 1000,
  depthMul: 1,
};
const coeffScratch = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
const riserCoeffScratch = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

export function defaultParams() {
  return {
    bpm: 124,
    output: 1,
    riserSeed: 1,
    pump: { enabled: true, depth: 0.75, shape: 0.62, rate: "1/4", offset: 0 },
    filter: { enabled: true, type: "lowpass", cutoff: 14000, resonance: 0.18 },
    performance: [],
    automation: null,
  };
}

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function clampBpm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 120;
  if (n < 40) return 40;
  if (n > 300) return 300;
  return n;
}

function fract(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 1) + 1) % 1;
}

export function expLerp(a, b, t) {
  const u = clamp01(t);
  const aa = Math.max(1e-6, a);
  const bb = Math.max(1e-6, b);
  return aa * Math.pow(bb / aa, u);
}

function easeInOut(u) {
  const x = clamp01(u);
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

/** Quarter-note beats covered by one pump cycle. */
export function divisionBeats(rate) {
  return RATE_BEATS[rate] ?? 1;
}

/** Seconds between pump hits. */
export function divisionSeconds(bpm, rate) {
  return (divisionBeats(rate) * 60) / clampBpm(bpm);
}

/** Seconds for a 4/4 phrase of `bars` bars. */
export function barsToSeconds(bpm, bars) {
  const n = Number(bars);
  const safe = Number.isFinite(n) && n > 0 ? n : 4;
  return (safe * 4 * 60) / clampBpm(bpm);
}

/** 1 at the hit, falling toward 0. Higher shape snaps back to loud faster. */
export function duckAmount(phase, shape) {
  const p = fract(phase);
  const k = 1.5 + clamp01(shape) * 10;
  return Math.exp(-k * p);
}

/** Gain multiplier for one pump cycle. Depth 0 leaves the signal alone. */
export function pumpGainAt(phase, depth, shape) {
  const d = clamp01(depth);
  if (d === 0) return 1;
  return 1 - d * duckAmount(phase, shape);
}

export function resonanceToQ(resonance) {
  return 0.5 * Math.pow(24, clamp01(resonance));
}

export function clampCutoff(hz, sampleRate) {
  const nyquist = sampleRate * 0.5 - 40;
  const n = Number(hz);
  const value = Number.isFinite(n) ? n : 1000;
  if (value < 20) return 20;
  if (value > nyquist) return Math.max(20, nyquist);
  return value;
}

function filterType(type) {
  if (type === "highpass" || type === "bandpass" || type === "lowpass") return type;
  return "lowpass";
}

/**
 * Live and offline gestures share this curve.
 * `heldFor` is how long the button has been down; `sweepSeconds` is a full travel.
 */
export function gestureTargets(input, out = {}) {
  const baseCutoff = Math.max(20, Number(input.baseCutoff) || 14000);
  const baseResonance = clamp01(input.baseResonance);
  const sweepSeconds = Math.max(0.05, Number(input.sweepSeconds) || 1);
  const heldFor = Math.max(0, Number(input.heldFor) || 0);
  const type = input.type;
  if (type === "cut") {
    const a = Math.min(1, heldFor / 0.008);
    out.cutoff = baseCutoff;
    out.resonance = baseResonance;
    out.gain = 1 - a;
    out.riser = 0;
    out.riserFreq = 1000;
    out.depthMul = 1;
    return out;
  }
  if (type === "build") {
    const from = Math.min(baseCutoff, 420);
    const u = clamp01(heldFor / sweepSeconds);
    const curved = easeInOut(u);
    out.cutoff = expLerp(from, 16500, curved);
    out.resonance = clamp01(baseResonance + (0.82 - baseResonance) * Math.sin(Math.PI * u) * 0.9);
    out.gain = 1;
    out.riser = curved ** 1.15;
    out.riserFreq = expLerp(220, 7600, u);
    out.depthMul = 1;
    return out;
  }
  if (type === "drop") {
    const from = Math.max(baseCutoff, 9000);
    const u = clamp01(heldFor / sweepSeconds);
    const curved = u ** 0.55;
    out.cutoff = expLerp(from, 80, curved);
    out.resonance = clamp01(Math.max(baseResonance, 0.45));
    out.gain = 1;
    out.riser = (1 - u) * 0.7;
    out.riserFreq = expLerp(6800, 140, u);
    out.depthMul = 1 + 0.35 * (1 - u);
    return out;
  }
  out.cutoff = baseCutoff;
  out.resonance = baseResonance;
  out.gain = 1;
  out.riser = 0;
  out.riserFreq = 1000;
  out.depthMul = 1;
  return out;
}

function mergeParams(params) {
  const defaults = defaultParams();
  const source = params && typeof params === "object" ? params : {};
  const pump = { ...defaults.pump, ...(source.pump || {}) };
  const filter = { ...defaults.filter, ...(source.filter || {}) };
  if (!RATE_BEATS[pump.rate]) pump.rate = defaults.pump.rate;
  pump.depth = clamp01(pump.depth);
  pump.shape = clamp01(pump.shape);
  pump.offset = fract(pump.offset);
  pump.enabled = pump.enabled !== false;
  filter.enabled = filter.enabled !== false;
  filter.type = filterType(filter.type);
  filter.resonance = clamp01(filter.resonance);
  const cutoff = Number(filter.cutoff);
  filter.cutoff = Number.isFinite(cutoff) ? cutoff : defaults.filter.cutoff;
  const output = Number(source.output);
  return {
    bpm: clampBpm(source.bpm ?? defaults.bpm),
    output: Number.isFinite(output) ? Math.min(1.5, Math.max(0, output)) : 1,
    riserSeed: Number.isFinite(Number(source.riserSeed)) ? Number(source.riserSeed) >>> 0 : 1,
    pump,
    filter,
    performance: Array.isArray(source.performance) ? source.performance : [],
    automation: source.automation && Array.isArray(source.automation.times) ? source.automation : null,
  };
}

function sampleAutomation(auto, time, key) {
  const values = auto[key];
  const times = auto.times;
  if (!values || values.length !== times.length || times.length === 0) return null;
  if (time <= times[0]) return Number(values[0]);
  const last = times.length - 1;
  if (time >= times[last]) return Number(values[last]);
  let lo = 0;
  let hi = last;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo] || 1;
  const u = (time - times[lo]) / span;
  return Number(values[lo]) + (Number(values[hi]) - Number(values[lo])) * u;
}

/** Resolve cutoff, resonance, mute, riser and pump depth at `time` seconds. */
export function sceneAt(time, params, out = sceneScratch) {
  const settings = params.__merged ? params : mergeParams(params);
  const baseCutoff = settings.filter.cutoff;
  const baseResonance = settings.filter.resonance;
  out.cutoff = baseCutoff;
  out.resonance = baseResonance;
  out.gain = 1;
  out.riser = 0;
  out.riserFreq = 1000;
  out.depthMul = 1;

  let chosen = null;
  let chosenRank = 0;
  for (const event of settings.performance) {
    if (!event || !RANK[event.type]) continue;
    const start = Number(event.start);
    const end = Number(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const release = RELEASE[event.type];
    if (time >= start && time < end + release && RANK[event.type] >= chosenRank) {
      chosen = event;
      chosenRank = RANK[event.type];
    }
  }

  if (chosen) {
    const start = Number(chosen.start);
    const end = Number(chosen.end);
    const release = RELEASE[chosen.type];
    const holdLen = end - start;
    const sweepSeconds = Math.max(0.05, Number(chosen.sweepSeconds) || holdLen);
    const heldFor = Math.min(holdLen, Math.max(0, time - start));
    gestureTargets(
      {
        type: chosen.type,
        heldFor,
        sweepSeconds,
        baseCutoff,
        baseResonance,
      },
      out,
    );
    if (time > end) {
      const u = clamp01((time - end) / release);
      const endCutoff = out.cutoff;
      const endResonance = out.resonance;
      const endGain = out.gain;
      const endRiser = out.riser;
      const endFreq = out.riserFreq;
      const endDepth = out.depthMul;
      out.cutoff = expLerp(endCutoff, baseCutoff, u);
      out.resonance = endResonance + (baseResonance - endResonance) * u;
      out.gain = endGain + (1 - endGain) * u;
      out.riser = endRiser * (1 - u);
      out.riserFreq = expLerp(endFreq, 1000, u);
      out.depthMul = endDepth + (1 - endDepth) * u;
    }
  }

  if (settings.automation) {
    const cutoff = sampleAutomation(settings.automation, time, "cutoff");
    const resonance = sampleAutomation(settings.automation, time, "resonance");
    const gain = sampleAutomation(settings.automation, time, "gain");
    const riser = sampleAutomation(settings.automation, time, "riser");
    const pumpDepth = sampleAutomation(settings.automation, time, "pumpDepth");
    if (cutoff != null && Number.isFinite(cutoff)) out.cutoff = cutoff;
    if (resonance != null && Number.isFinite(resonance)) out.resonance = resonance;
    if (gain != null && Number.isFinite(gain)) out.gain = gain;
    if (riser != null && Number.isFinite(riser)) out.riser = riser;
    if (pumpDepth != null && Number.isFinite(pumpDepth)) {
      out.depthMul = settings.pump.depth > 0 ? pumpDepth / settings.pump.depth : 0;
    }
  }
  return out;
}

function biquadCoeffs(type, freq, q, sampleRate, out) {
  const f = clampCutoff(freq, sampleRate);
  const Q = Math.max(0.05, q);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  let b0;
  let b1;
  let b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  if (type === "highpass") {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else if (type === "bandpass") {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  } else {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  }
  out.b0 = b0 / a0;
  out.b1 = b1 / a0;
  out.b2 = b2 / a0;
  out.a1 = a1 / a0;
  out.a2 = a2 / a0;
  return out;
}

function processBiquad(state, x, c) {
  const y = c.b0 * x + state.z1;
  state.z1 = c.b1 * x - c.a1 * y + state.z2;
  state.z2 = c.b2 * x - c.a2 * y;
  if (state.z1 > -1e-15 && state.z1 < 1e-15) state.z1 = 0;
  if (state.z2 > -1e-15 && state.z2 < 1e-15) state.z2 = 0;
  return y;
}

function limit(x) {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

function mulberry32(seed) {
  let a = seed >>> 0 || 1;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readBuffer(buffer) {
  if (!buffer || typeof buffer !== "object") {
    throw new TypeError("processPumpSweep expects an audio buffer");
  }
  const sampleRate = Number(buffer.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError("buffer.sampleRate must be a positive number");
  }
  let channels;
  if (typeof buffer.getChannelData === "function") {
    const count = buffer.numberOfChannels || (buffer.channels ? buffer.channels.length : 0);
    if (!count) throw new TypeError("buffer has no channels");
    channels = [];
    for (let i = 0; i < count; i++) channels.push(Float32Array.from(buffer.getChannelData(i)));
  } else if (Array.isArray(buffer.channels) && buffer.channels.length) {
    channels = buffer.channels.map((channel) => Float32Array.from(channel));
  } else {
    throw new TypeError("buffer must provide getChannelData() or channels");
  }
  const length = channels.reduce((shortest, channel) => Math.min(shortest, channel.length), channels[0].length);
  return { sampleRate, channels, length };
}

function makeBuffer(sampleRate, channels) {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0]?.length || 0,
    channels,
    getChannelData(index) {
      if (index < 0 || index >= channels.length) throw new RangeError("channel out of range");
      return channels[index];
    },
  };
}

export function prepareParams(params) {
  const settings = mergeParams(params);
  settings.__merged = true;
  return settings;
}

/**
 * Render pumping and filter moves into a new buffer. The input is not modified.
 * `buffer` is an AudioBuffer or `{ sampleRate, channels: Float32Array[] }`.
 */
export function processPumpSweep(buffer, params = {}) {
  const source = readBuffer(buffer);
  const settings = prepareParams(params);
  const filters = source.channels.map(() => ({ z1: 0, z2: 0 }));
  const riserState = { z1: 0, z2: 0 };
  const rng = mulberry32(settings.riserSeed || 1);
  const outChannels = source.channels.map(() => new Float32Array(source.length));
  const cycle = divisionSeconds(settings.bpm, settings.pump.rate);
  const sr = source.sampleRate;
  let lastCutoff = NaN;
  let lastQ = NaN;
  let lastType = "";
  let lastRiserF = NaN;

  for (let i = 0; i < source.length; i++) {
    const time = i / sr;
    const scene = sceneAt(time, settings, sceneScratch);
    const phase = fract(time / cycle + settings.pump.offset);
    const depth = settings.pump.enabled ? Math.min(1, settings.pump.depth * scene.depthMul) : 0;
    const gain = pumpGainAt(phase, depth, settings.pump.shape) * scene.gain * settings.output;

    let riserSample = 0;
    if (scene.riser > 0.0008) {
      const noise = rng() * 2 - 1;
      const rf = clampCutoff(scene.riserFreq, sr);
      if (Math.abs(rf - lastRiserF) > 0.5) {
        biquadCoeffs("bandpass", rf, 3.2, sr, riserCoeffScratch);
        lastRiserF = rf;
      }
      riserSample = processBiquad(riserState, noise, riserCoeffScratch) * scene.riser * 0.28;
    }

    if (settings.filter.enabled) {
      const cutoff = clampCutoff(scene.cutoff, sr);
      const q = resonanceToQ(scene.resonance);
      if (cutoff !== lastCutoff || q !== lastQ || settings.filter.type !== lastType) {
        biquadCoeffs(settings.filter.type, cutoff, q, sr, coeffScratch);
        lastCutoff = cutoff;
        lastQ = q;
        lastType = settings.filter.type;
      }
      for (let c = 0; c < outChannels.length; c++) {
        const filtered = processBiquad(filters[c], source.channels[c][i], coeffScratch);
        outChannels[c][i] = limit((filtered + riserSample) * gain);
      }
    } else {
      for (let c = 0; c < outChannels.length; c++) {
        outChannels[c][i] = limit((source.channels[c][i] + riserSample) * gain);
      }
    }
  }

  return makeBuffer(sr, outChannels);
}

function mixdownLowpass(buffer) {
  const source = readBuffer(buffer);
  const sr = source.sampleRate;
  const mono = new Float32Array(source.length);
  const inv = 1 / source.channels.length;
  const dt = 1 / sr;
  const alpha = dt / (1 / (2 * Math.PI * 150) + dt);
  let low = 0;
  for (let i = 0; i < source.length; i++) {
    let sum = 0;
    for (let c = 0; c < source.channels.length; c++) sum += source.channels[c][i];
    const x = sum * inv;
    low += alpha * (x - low);
    mono[i] = low;
  }
  return { mono, sampleRate: sr };
}

/**
 * Guess tempo from kick-weighted energy. Returns `{ bpm, confidence }`.
 * Confidence is 0..1 against the best integer tempo in range.
 */
export function detectBpm(buffer, opts = {}) {
  const fallback = clampBpm(opts.fallback ?? 120);
  const minBpm = Math.max(60, Math.round(opts.minBpm ?? 80));
  const maxBpm = Math.min(200, Math.round(opts.maxBpm ?? 170));
  const { mono, sampleRate } = mixdownLowpass(buffer);
  const hop = 256;
  const frames = Math.floor(mono.length / hop);
  if (frames < 24) return { bpm: fallback, confidence: 0 };
  const flux = new Float32Array(frames);
  let prev = 0;
  for (let i = 0; i < frames; i++) {
    let energy = 0;
    const start = i * hop;
    for (let j = 0; j < hop; j++) {
      const s = mono[start + j];
      energy += s * s;
    }
    const value = energy / hop;
    flux[i] = Math.max(0, value - prev);
    prev = value;
  }
  let zero = 0;
  for (let i = 0; i < frames; i++) zero += flux[i] * flux[i];
  if (zero < 1e-12) return { bpm: fallback, confidence: 0 };

  const hopRate = sampleRate / hop;
  const scores = new Map();
  function scoreAt(bpm) {
    const key = Math.round(bpm);
    if (scores.has(key)) return scores.get(key);
    const lag = Math.round((60 / key) * hopRate);
    if (lag < 2 || lag >= frames - 2) {
      scores.set(key, 0);
      return 0;
    }
    let corr = 0;
    const limit = frames - lag;
    for (let i = 0; i < limit; i++) corr += flux[i] * flux[i + lag];
    const score = corr / zero;
    scores.set(key, score);
    return score;
  }

  let bestBpm = fallback;
  let bestScore = -1;
  for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
    const score = scoreAt(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  if (bestBpm * 2 <= maxBpm && scoreAt(bestBpm * 2) >= bestScore * 0.92) {
    bestBpm *= 2;
    bestScore = scoreAt(bestBpm);
  }
  const confidence = Math.max(0, Math.min(1, bestScore));
  return { bpm: bestBpm, confidence };
}

function addKick(data, start, sr) {
  const n = Math.floor(0.22 * sr);
  let phase = 0;
  for (let i = 0; i < n && start + i < data.length; i++) {
    const te = i / sr;
    const f = 48 + 150 * Math.exp(-te * 26);
    phase += (2 * Math.PI * f) / sr;
    const env = Math.exp(-te * 14);
    const click = i < 30 ? (1 - i / 30) * 0.35 : 0;
    data[start + i] += Math.sin(phase) * env * 0.9 + click * (i % 2 === 0 ? 1 : -1);
  }
}

function addHat(data, start, sr, amp, rng) {
  const n = Math.floor(0.035 * sr);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < n && start + i < data.length; i++) {
    const noise = rng() * 2 - 1;
    hp = noise - prev + 0.94 * hp;
    prev = noise;
    const env = Math.exp(-i / (0.008 * sr));
    data[start + i] += hp * env * amp;
  }
}

function addClap(data, start, sr, rng) {
  const bursts = [0, 0.012, 0.023];
  for (const delay of bursts) {
    const at = start + Math.floor(delay * sr);
    const n = Math.floor(0.08 * sr);
    for (let i = 0; i < n && at + i < data.length; i++) {
      const env = Math.exp(-i / (0.02 * sr));
      data[at + i] += (rng() * 2 - 1) * env * 0.18;
    }
  }
}

function addBass(data, start, n, sr, freq) {
  let phase = 0;
  for (let i = 0; i < n && start + i < data.length; i++) {
    phase += (2 * Math.PI * freq) / sr;
    const te = i / Math.max(1, n);
    const env = 0.82 + 0.18 * Math.sin(Math.PI * te);
    data[start + i] += Math.sin(phase) * 0.3 * env;
  }
}

/** A short original drum-and-bass loop so the desk is audible before a file drop. */
export function renderDemoLoop(opts = {}) {
  const bpm = clampBpm(opts.bpm ?? 124);
  const bars = Math.max(1, Math.round(Number(opts.bars) || 4));
  const sampleRate = Number(opts.sampleRate) || 44100;
  const beat = 60 / bpm;
  const beats = bars * 4;
  const length = Math.floor(beats * beat * sampleRate);
  const mono = new Float32Array(length);
  const rng = mulberry32(0x51a7);
  for (let b = 0; b < beats; b++) {
    const start = Math.floor(b * beat * sampleRate);
    addKick(mono, start, sampleRate);
    addHat(mono, start, sampleRate, 0.07, rng);
    addHat(mono, start + Math.floor(beat * 0.5 * sampleRate), sampleRate, 0.12, rng);
    if (b % 4 === 1 || b % 4 === 3) addClap(mono, start, sampleRate, rng);
    const freq = b % 4 === 2 ? 73.42 : 49;
    addBass(mono, start, Math.floor(beat * sampleRate), sampleRate, freq);
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < length; i++) mono[i] *= g;
  }
  const right = Float32Array.from(mono);
  return { bpm, buffer: makeBuffer(sampleRate, [mono, right]) };
}
