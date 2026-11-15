/* Atelier Instruments — MIT License.
 * Offline trailer gesture renderer. No DOM, no Web Audio.
 *
 * render(params, options) -> {
 *   sampleRate, channels, left, right, frames, gestureFrames,
 *   duration, gestureDuration, peak, params
 * }
 * The same params and sample rate always produce the same samples.
 */

import { midiToHz } from '../../shared/midi.js';

export const KINDS = Object.freeze([
  { id: 'riser', name: 'Riser', blurb: 'Climbs in pitch and brightness, then peaks on the cut.' },
  { id: 'whoosh', name: 'Whoosh', blurb: 'A pass of air. Pitch sets how high the band flies.' },
  { id: 'brass', name: 'Brass Hit', blurb: 'Deep stacked horns with a falling attack.' },
  { id: 'subdrop', name: 'Sub Drop', blurb: 'Low weight that dives under the frame.' },
  { id: 'reverse', name: 'Reverse', blurb: 'A swell run backward into a landing.' },
  { id: 'impact', name: 'Impact', blurb: 'Transient, body, and a tail you can feel.' },
]);

const KIND_IDS = new Set(KINDS.map((kind) => kind.id));

export const DEFAULT_PARAMS = Object.freeze({
  kind: 'riser',
  lengthMode: 'seconds',
  seconds: 8,
  bars: 4,
  tempo: 120,
  intensity: 0.72,
  pitch: 36,
  darkness: 0.4,
  size: 0.58,
  seed: 1,
});

const TAU = Math.PI * 2;
const MAX_GESTURE = 32;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function normalizeParams(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    kind: KIND_IDS.has(src.kind) ? src.kind : DEFAULT_PARAMS.kind,
    lengthMode: src.lengthMode === 'bars' ? 'bars' : 'seconds',
    seconds: clamp(src.seconds, 0.2, 24, DEFAULT_PARAMS.seconds),
    bars: Math.round(clamp(src.bars, 1, 16, DEFAULT_PARAMS.bars)),
    tempo: clamp(src.tempo, 40, 240, DEFAULT_PARAMS.tempo),
    intensity: clamp(src.intensity, 0, 1, DEFAULT_PARAMS.intensity),
    pitch: clamp(src.pitch, 16, 84, DEFAULT_PARAMS.pitch),
    darkness: clamp(src.darkness, 0, 1, DEFAULT_PARAMS.darkness),
    size: clamp(src.size, 0, 1, DEFAULT_PARAMS.size),
    seed: Math.floor(clamp(src.seed, 1, 999999999, DEFAULT_PARAMS.seed)),
  };
}

/** Musical length in seconds, capped so a render cannot run away. */
export function gestureSeconds(params) {
  const p = params && params.kind ? params : normalizeParams(params);
  const seconds = p.lengthMode === 'bars'
    ? (p.bars * 4 * 60) / p.tempo
    : p.seconds;
  if (!Number.isFinite(seconds)) return 0.2;
  if (seconds < 0.2) return 0.2;
  if (seconds > MAX_GESTURE) return MAX_GESTURE;
  return seconds;
}

/** Room after the gesture so the peak is not chopped off. */
export function tailSeconds(params) {
  const p = params && params.kind ? params : normalizeParams(params);
  const size = p.size;
  if (p.kind === 'whoosh') return 0.02 + size * 0.18;
  if (p.kind === 'riser' || p.kind === 'reverse') return 0.06 + size * 0.8;
  return 0.04 + size * 0.45;
}

export function totalSeconds(params) {
  return gestureSeconds(params) + tailSeconds(params);
}

function hashSeed(seed) {
  let h = (Math.floor(Number(seed)) >>> 0) || 1;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic cousin of the current patch. Index 0 is already a little
 * different; the panel uses it for batch export.
 */
export function variationParams(base, index) {
  const p = normalizeParams(base);
  const n = Math.max(0, Math.floor(Number(index) || 0));
  const rng = mulberry32(hashSeed(p.seed * 997 + n * 131 + 17));
  const jitter = (amount) => (rng() * 2 - 1) * amount;
  return normalizeParams({
    ...p,
    seed: (p.seed + n * 17 + 1) % 1000000000 || 1,
    pitch: p.pitch + jitter(2),
    darkness: p.darkness + jitter(0.1),
    size: p.size + jitter(0.1),
    intensity: p.intensity + jitter(0.08),
    seconds: p.seconds * (0.92 + rng() * 0.16),
    tempo: p.tempo + jitter(3),
  });
}

function hzFromNote(note) {
  const hz = midiToHz(note);
  if (!Number.isFinite(hz)) return 55;
  if (hz < 20) return 20;
  return hz;
}

function freqDt(hz, sampleRate) {
  const dt = hz / sampleRate;
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  if (dt > 0.45) return 0.45;
  return dt;
}

function advance(phase, dt) {
  phase += dt;
  if (phase >= 1) phase -= 1;
  return phase;
}

function polyblep(phase, dt) {
  if (dt <= 0) return 0;
  if (phase < dt) {
    const t = phase / dt;
    return t + t - t * t - 1;
  }
  if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function sawSample(phase, dt) {
  return 2 * phase - 1 - polyblep(phase, dt);
}

function sineAt(phase) {
  return Math.sin(phase * TAU);
}

function white(rng) {
  return rng() * 2 - 1;
}

function createBiquad() {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function clampFreq(freq, sampleRate) {
  const max = sampleRate * 0.45;
  if (!Number.isFinite(freq)) return 200;
  if (freq < 20) return 20;
  if (freq > max) return max;
  return freq;
}

function clampQ(q) {
  if (!Number.isFinite(q)) return 0.707;
  if (q < 0.3) return 0.3;
  if (q > 8) return 8;
  return q;
}

function setCommon(f, freq, q, sampleRate) {
  const w0 = TAU * clampFreq(freq, sampleRate) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * clampQ(q));
  return { cos, sin, alpha, a0: 1 + alpha };
}

function setLowpass(f, freq, q, sampleRate) {
  const { cos, alpha, a0 } = setCommon(f, freq, q, sampleRate);
  const b0 = (1 - cos) / 2;
  f.b0 = b0 / a0;
  f.b1 = (1 - cos) / a0;
  f.b2 = b0 / a0;
  f.a1 = (-2 * cos) / a0;
  f.a2 = (1 - alpha) / a0;
}

function setHighpass(f, freq, q, sampleRate) {
  const { cos, alpha, a0 } = setCommon(f, freq, q, sampleRate);
  const b0 = (1 + cos) / 2;
  f.b0 = b0 / a0;
  f.b1 = -(1 + cos) / a0;
  f.b2 = b0 / a0;
  f.a1 = (-2 * cos) / a0;
  f.a2 = (1 - alpha) / a0;
}

function setBandpass(f, freq, q, sampleRate) {
  const { cos, alpha, a0 } = setCommon(f, freq, q, sampleRate);
  f.b0 = alpha / a0;
  f.b1 = 0;
  f.b2 = -alpha / a0;
  f.a1 = (-2 * cos) / a0;
  f.a2 = (1 - alpha) / a0;
}

function processBiquad(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = Number.isFinite(y) ? y : 0;
  if (f.y1 < 1e-20 && f.y1 > -1e-20) f.y1 = 0;
  return f.y1;
}

function synthRiser(out, gestureFrames, sampleRate, p, rng) {
  const lp = createBiquad();
  let phase = 0;
  let phaseB = rng() * 0.5;
  let phaseC = rng() * 0.5;
  let subPhase = 0;
  const detune = (rng() - 0.5) * 0.15;
  const startNote = p.pitch - (8 + p.intensity * 10);
  const endNote = p.pitch;
  const startCut = 140 + (1 - p.darkness) * 180;
  const endCut = 700 + (1 - p.darkness) * 7800;
  for (let i = 0; i < gestureFrames; i += 1) {
    const t = gestureFrames <= 1 ? 1 : i / (gestureFrames - 1);
    const curve = t ** (1.25 + (1 - p.intensity) * 1.5);
    const note = startNote + (endNote - startNote) * curve;
    const dt = freqDt(hzFromNote(note), sampleRate);
    const dtB = freqDt(hzFromNote(note + 0.12 + detune), sampleRate);
    const dtC = freqDt(hzFromNote(note - 0.08 + detune), sampleRate);
    phase = advance(phase, dt);
    phaseB = advance(phaseB, dtB);
    phaseC = advance(phaseC, dtC);
    const saws = (sawSample(phase, dt) + sawSample(phaseB, dtB) + sawSample(phaseC, dtC)) / 3;
    const shaped = Math.tanh(saws * (1.1 + p.intensity * 2.2));
    if ((i & 15) === 0) {
      const cut = startCut * (endCut / startCut) ** curve;
      setLowpass(lp, cut, 0.7, sampleRate);
    }
    const noise = processBiquad(lp, white(rng));
    let sub = 0;
    if (t > 0.42) {
      const subDt = freqDt(hzFromNote(note - 12), sampleRate);
      subPhase = advance(subPhase, subDt);
      sub = sineAt(subPhase) * ((t - 0.42) / 0.58) * (0.22 + p.size * 0.28);
    }
    const amp = (0.25 + curve * 0.75) * (0.45 + p.intensity * 0.7);
    const toneGain = 0.34 + (1 - p.darkness) * 0.28;
    const noiseGain = 0.42 + p.darkness * 0.28;
    out[i] = (shaped * toneGain + noise * noiseGain + sub) * amp;
  }
  const accent = Math.max(1, Math.floor(0.045 * sampleRate));
  const accentStart = Math.max(0, gestureFrames - accent);
  let click = 0.25;
  const clickDt = freqDt(hzFromNote(p.pitch), sampleRate);
  for (let i = accentStart; i < gestureFrames; i += 1) {
    const u = (i - accentStart) / accent;
    const env = Math.sin(u * Math.PI) * (0.25 + p.intensity * 0.75);
    click = advance(click, clickDt);
    out[i] += (white(rng) * 0.55 + sineAt(click) * 0.45) * env * 0.55;
  }
}

function whooshEnv(t) {
  const peakAt = 0.58;
  if (t <= 0 || t >= 1) return 0;
  if (t < peakAt) return (t / peakAt) ** 1.35;
  return ((1 - t) / (1 - peakAt)) ** 1.15;
}

function synthWhoosh(out, gestureFrames, sampleRate, p, rng) {
  const bp = createBiquad();
  const bp2 = createBiquad();
  const rng2 = mulberry32(hashSeed(p.seed + 97));
  const rng3 = mulberry32(hashSeed(p.seed + 193));
  const startHz = Math.max(90, hzFromNote(p.pitch) * (0.8 + p.darkness * 0.6));
  const endHz = Math.min(sampleRate * 0.42, startHz * 2 ** (1.5 + (1 - p.darkness) * 2.1));
  const q = 1.2 + p.intensity * 2.4;
  let wind = 0;
  const windFollow = 0.06 + p.darkness * 0.1;
  for (let i = 0; i < gestureFrames; i += 1) {
    const t = gestureFrames <= 1 ? 1 : i / (gestureFrames - 1);
    const sweep = t ** 0.8;
    const hz = startHz * (endHz / startHz) ** sweep;
    if ((i & 7) === 0) {
      setBandpass(bp, hz, q, sampleRate);
      setBandpass(bp2, Math.max(50, hz * 0.48), Math.max(0.5, q * 0.65), sampleRate);
    }
    const air = processBiquad(bp, white(rng));
    const body = processBiquad(bp2, white(rng2));
    const gust = white(rng3);
    wind += (gust - wind) * windFollow;
    const env = whooshEnv(t);
    out[i] = (air * (1.15 + p.intensity * 0.55) + body * (0.55 + p.darkness * 0.55) + wind * 0.85) * env * 1.6;
  }
}

function synthBrass(out, gestureFrames, sampleRate, p, rng) {
  const lp = createBiquad();
  const attack = Math.max(1, Math.floor((0.006 + (1 - p.intensity) * 0.012) * sampleRate));
  const dropSamples = Math.max(attack + 1, Math.floor(0.42 * sampleRate));
  let phases = [rng() * 0.2, rng() * 0.2, rng() * 0.2, rng() * 0.2];
  let subPhase = 0.25;
  const offsets = [0, 0.08, -0.07, 7];
  const gains = [1, 0.85, 0.85, 0.42];
  const chiffN = Math.max(1, Math.floor(0.028 * sampleRate));
  const openCut = 280 + (1 - p.darkness) * 3600;
  const closedCut = 90 + (1 - p.darkness) * 220;
  for (let i = 0; i < gestureFrames; i += 1) {
    const u = i < attack ? i / attack : 1;
    const decayT = i <= attack ? 0 : (i - attack) / Math.max(1, gestureFrames - attack);
    const env = u * (1 - decayT) ** (0.85 + (1 - p.intensity) * 1.1);
    const drop = Math.min(1, i / dropSamples);
    const note = p.pitch + (1.4 + p.intensity * 2.8) * (1 - drop) ** 2;
    let tone = 0;
    for (let v = 0; v < 4; v += 1) {
      const dt = freqDt(hzFromNote(note + offsets[v]), sampleRate);
      phases[v] = advance(phases[v], dt);
      tone += sawSample(phases[v], dt) * gains[v];
    }
    tone /= 3.1;
    const driven = Math.tanh(tone * (1.4 + p.intensity * 2.4));
    if ((i & 7) === 0) {
      const fEnv = Math.exp(-i / (sampleRate * (0.12 + (1 - p.intensity) * 0.35)));
      setLowpass(lp, closedCut + (openCut - closedCut) * fEnv, 0.85 + p.intensity * 0.45, sampleRate);
    }
    let chiff = 0;
    if (i < chiffN) chiff = white(rng) * (1 - i / chiffN) * (0.25 + p.intensity * 0.35);
    const subDt = freqDt(hzFromNote(note - 12), sampleRate);
    subPhase = advance(subPhase, subDt);
    const sub = sineAt(subPhase) * (0.18 + p.size * 0.16);
    out[i] = (processBiquad(lp, driven) * 0.82 + sub + chiff) * env * (0.9 + p.intensity * 0.15);
  }
}

function synthSubDrop(out, gestureFrames, sampleRate, p, rng) {
  const dive = 7 + p.intensity * 17;
  let phase = 0.25;
  let fifth = 0.1;
  const clickN = Math.max(1, Math.floor(0.006 * sampleRate));
  const hp = createBiquad();
  setHighpass(hp, 900, 0.7, sampleRate);
  for (let i = 0; i < gestureFrames; i += 1) {
    const t = gestureFrames <= 1 ? 1 : i / (gestureFrames - 1);
    const note = p.pitch - dive * t ** 0.55;
    const dt = freqDt(hzFromNote(note), sampleRate);
    phase = advance(phase, dt);
    const raw = sineAt(phase);
    const shaped = p.darkness > 0.55 ? raw : Math.tanh(raw * (1 + (1 - p.darkness) * p.intensity * 3));
    const env = (1 - t) ** 0.28;
    fifth = advance(fifth, freqDt(hzFromNote(note + 7), sampleRate));
    const overtone = sineAt(fifth) * (1 - p.darkness) * 0.12 * env;
    let click = 0;
    if (i < clickN) {
      const e = 1 - i / clickN;
      click = (i === 1 ? 0.7 : 0) * e + processBiquad(hp, white(rng)) * e * 0.45;
    }
    const air = white(rng) * (1 - p.darkness) * 0.05 * (1 - t);
    out[i] = (shaped * (0.72 + p.intensity * 0.2) + overtone + air) * env + click * p.intensity;
  }
}

function synthReverse(out, gestureFrames, sampleRate, p, rng) {
  const tmp = new Float32Array(gestureFrames);
  const lp = createBiquad();
  const startCut = 320 + (1 - p.darkness) * 400;
  const endCut = 1800 + (1 - p.darkness) * 5200;
  let phase = 0;
  let phase2 = 0;
  const note = p.pitch + 12;
  for (let i = 0; i < gestureFrames; i += 1) {
    const t = gestureFrames <= 1 ? 1 : i / (gestureFrames - 1);
    const env = (1 - t) ** (0.75 + (1 - p.intensity) * 0.8);
    const dt = freqDt(hzFromNote(note), sampleRate);
    const dt2 = freqDt(hzFromNote(note + 7), sampleRate);
    phase = advance(phase, dt);
    phase2 = advance(phase2, dt2);
    if ((i & 15) === 0) setLowpass(lp, startCut + (endCut - startCut) * (1 - t), 0.7, sampleRate);
    const noise = processBiquad(lp, white(rng));
    const tone = sineAt(phase) * 0.28 + sawSample(phase2, dt2) * 0.16;
    tmp[i] = (noise * (0.62 + p.darkness * 0.2) + tone * (0.45 + (1 - p.darkness) * 0.4)) * env;
  }
  for (let i = 0; i < gestureFrames; i += 1) out[i] = tmp[gestureFrames - 1 - i];
  const accent = Math.max(1, Math.floor(0.04 * sampleRate));
  const start = Math.max(0, gestureFrames - accent);
  let click = 0.25;
  const clickDt = freqDt(hzFromNote(p.pitch), sampleRate);
  for (let i = start; i < gestureFrames; i += 1) {
    const u = (i - start) / accent;
    const env = Math.sin(u * Math.PI) * (0.3 + p.intensity * 0.6);
    click = advance(click, clickDt);
    out[i] += (sineAt(click) * 0.65 + white(rng) * 0.35) * env;
  }
}

function synthImpact(out, gestureFrames, sampleRate, p, rng) {
  const clickN = Math.max(2, Math.floor(0.005 * sampleRate));
  const hp = createBiquad();
  const bp = createBiquad();
  setHighpass(hp, 1600, 0.707, sampleRate);
  let phase = 0.25;
  let subPhase = 0.25;
  let metalA = 0;
  let metalB = 0;
  const bodyDecay = Math.max(0.08, 0.16 + p.size * 0.22);
  const subDecay = Math.max(0.12, (gestureFrames / sampleRate) * (0.35 + p.size * 0.4));
  for (let i = 0; i < gestureFrames; i += 1) {
    const t = gestureFrames <= 1 ? 1 : i / gestureFrames;
    const semis = 8 * (1 - Math.exp(-i / (0.07 * sampleRate)));
    const bodyHz = hzFromNote(p.pitch - semis);
    const bodyDt = freqDt(bodyHz, sampleRate);
    phase = advance(phase, bodyDt);
    const bodyEnv = Math.exp(-i / (bodyDecay * sampleRate));
    const body = sineAt(phase) * bodyEnv * 0.72;

    const subHz = hzFromNote(p.pitch - 12 - semis * 0.45);
    subPhase = advance(subPhase, freqDt(subHz, sampleRate));
    const sub = sineAt(subPhase) * Math.exp(-i / (subDecay * sampleRate)) * (0.48 + p.size * 0.22);

    let click = 0;
    if (i < clickN) {
      const e = (1 - i / clickN) ** 0.55;
      const impulse = i === 2 ? 1 : 0;
      click = (impulse * 0.95 + processBiquad(hp, white(rng)) * 0.55) * e * (0.75 + p.intensity * 0.7);
    }

    if ((i & 15) === 0) {
      const cut = 180 + (1 - p.darkness) * 2200 * Math.exp(-t * 1.6);
      setBandpass(bp, cut, 0.9, sampleRate);
    }
    const air = processBiquad(bp, white(rng)) * Math.exp(-t * (2.4 + p.darkness * 2)) * (0.22 + (1 - p.darkness) * 0.2);

    let metal = 0;
    if (p.darkness < 0.8) {
      metalA = advance(metalA, freqDt(bodyHz * 2.41, sampleRate));
      metalB = advance(metalB, freqDt(bodyHz * 3.87, sampleRate));
      const mEnv = Math.exp(-i / (0.055 * sampleRate)) * (1 - p.darkness);
      metal = (sineAt(metalA) * 0.32 + sineAt(metalB) * 0.18) * mEnv;
    }
    out[i] = click + body + sub + air + metal;
  }
}

function comb(input, sampleRate, delaySec, feedback, damp) {
  const n = input.length;
  const delay = Math.max(1, Math.floor(delaySec * sampleRate));
  const buf = new Float32Array(delay);
  const out = new Float32Array(n);
  let index = 0;
  let filter = 0;
  const d = Math.min(0.92, Math.max(0, damp));
  const fb = Math.min(0.72, Math.max(0, feedback));
  for (let i = 0; i < n; i += 1) {
    const delayed = buf[index];
    filter = delayed * (1 - d) + filter * d;
    const write = input[i] + filter * fb;
    buf[index] = Math.tanh(write);
    out[i] = delayed;
    index += 1;
    if (index >= delay) index = 0;
  }
  return out;
}

function spatialize(mono, gestureFrames, sampleRate, params) {
  const n = mono.length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const size = params.size;
  if (params.kind === 'whoosh') {
    const span = Math.max(1, gestureFrames - 1);
    for (let i = 0; i < n; i += 1) {
      const t = Math.min(1, i / span);
      const l = Math.cos(t * Math.PI * 0.5);
      const r = Math.sin(t * Math.PI * 0.5);
      left[i] = mono[i] * l;
      right[i] = mono[i] * r;
    }
  } else {
    const delay = Math.max(1, Math.floor((0.0035 + size * 0.016) * sampleRate));
    const side = 0.12 + size * 0.5;
    for (let i = 0; i < n; i += 1) {
      const delayed = i >= delay ? mono[i - delay] : 0;
      left[i] = mono[i];
      right[i] = mono[i] * (1 - side * 0.28) + delayed * side;
    }
  }
  if (size > 0.015) {
    const damp = 0.18 + params.darkness * 0.62;
    const fb = 0.22 + size * 0.46;
    const wetL = comb(left, sampleRate, 0.0297, fb, damp);
    const wetR = comb(right, sampleRate, 0.0371, fb, damp);
    const wetL2 = comb(wetL, sampleRate, 0.0413, fb * 0.82, damp);
    const wetR2 = comb(wetR, sampleRate, 0.0527, fb * 0.82, damp);
    const mix = 0.06 + size * 0.4;
    for (let i = 0; i < n; i += 1) {
      left[i] = left[i] * (1 - mix * 0.22) + (wetL[i] * 0.62 + wetL2[i] * 0.38) * mix;
      right[i] = right[i] * (1 - mix * 0.22) + (wetR[i] * 0.62 + wetR2[i] * 0.38) * mix;
    }
  }
  return { left, right };
}

function dcBlock(buffer, sampleRate) {
  const hp = createBiquad();
  setHighpass(hp, 22, 0.707, sampleRate);
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = processBiquad(hp, buffer[i]);
}

function applyEdgeFades(buffer, sampleRate, fadeInSec, fadeOutSec) {
  const fadeIn = Math.min(buffer.length, Math.max(1, Math.floor(fadeInSec * sampleRate)));
  const fadeOut = Math.min(buffer.length, Math.max(1, Math.floor(fadeOutSec * sampleRate)));
  for (let i = 0; i < fadeIn; i += 1) buffer[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i += 1) buffer[buffer.length - 1 - i] *= i / fadeOut;
}

function finish(left, right, sampleRate, params) {
  const drive = 0.85 + params.intensity * 0.7;
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    let l = left[i] * drive;
    let r = right[i] * drive;
    if (!Number.isFinite(l)) l = 0;
    if (!Number.isFinite(r)) r = 0;
    l = Math.tanh(l);
    r = Math.tanh(r);
    left[i] = l;
    right[i] = r;
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > peak) peak = m;
  }
  const ceiling = 0.89;
  if (peak > ceiling && peak > 0) {
    const gain = ceiling / peak;
    for (let i = 0; i < left.length; i += 1) {
      left[i] *= gain;
      right[i] *= gain;
    }
    peak = ceiling;
  } else if (peak > 0.001 && peak < 0.78) {
    const gain = Math.min(5, 0.78 / peak);
    for (let i = 0; i < left.length; i += 1) {
      left[i] *= gain;
      right[i] *= gain;
    }
    peak *= gain;
  }
  const sharp = params.kind === 'impact' || params.kind === 'brass' || params.kind === 'subdrop';
  applyEdgeFades(left, sampleRate, sharp ? 0.0012 : 0.006, 0.018);
  applyEdgeFades(right, sampleRate, sharp ? 0.0012 : 0.006, 0.018);
  peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    const m = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (m > peak) peak = m;
  }
  return peak;
}

/**
 * Render a trailer gesture offline.
 * @param {object} rawParams
 * @param {{sampleRate?: number}} [options]
 */
export function render(rawParams, options = {}) {
  const params = normalizeParams(rawParams);
  const sampleRate = options.sampleRate ?? 48000;
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || sampleRate > 192000) {
    throw new Error('sampleRate must be between 4000 and 192000');
  }
  const gestureFrames = Math.max(1, Math.round(gestureSeconds(params) * sampleRate));
  const frames = gestureFrames + Math.round(tailSeconds(params) * sampleRate);
  const rng = mulberry32(hashSeed(params.seed));
  const mono = new Float32Array(frames);
  if (params.kind === 'riser') synthRiser(mono, gestureFrames, sampleRate, params, rng);
  else if (params.kind === 'whoosh') synthWhoosh(mono, gestureFrames, sampleRate, params, rng);
  else if (params.kind === 'brass') synthBrass(mono, gestureFrames, sampleRate, params, rng);
  else if (params.kind === 'subdrop') synthSubDrop(mono, gestureFrames, sampleRate, params, rng);
  else if (params.kind === 'reverse') synthReverse(mono, gestureFrames, sampleRate, params, rng);
  else synthImpact(mono, gestureFrames, sampleRate, params, rng);

  const stereo = spatialize(mono, gestureFrames, sampleRate, params);
  dcBlock(stereo.left, sampleRate);
  dcBlock(stereo.right, sampleRate);
  const peak = finish(stereo.left, stereo.right, sampleRate, params);
  return {
    sampleRate,
    channels: 2,
    left: stereo.left,
    right: stereo.right,
    frames,
    gestureFrames,
    duration: frames / sampleRate,
    gestureDuration: gestureFrames / sampleRate,
    peak,
    params,
  };
}
