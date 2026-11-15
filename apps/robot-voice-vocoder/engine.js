/**
 * Robot Voice Vocoder — DOM-free channel vocoder and carrier synth.
 * renderVocoded(voiceBuffer, midiNotes, preset) bounces audio offline.
 * MIT — Atelier Instruments
 */

export const MODE_IDS = Object.freeze(["robot", "choir", "talkbox", "whisper", "monotone"]);
export const BAND_CHOICES = Object.freeze([8, 16, 24, 32]);
export const WAVE_IDS = Object.freeze(["saw", "square", "supersaw", "noise"]);
export const ARP_PATTERNS = Object.freeze(["up", "down", "updown", "random"]);

const CARRIER_GAIN = 0.62;
const BAND_MAKEUP = 48;
const SIB_GAIN = 4.5;

const DEFAULTS = Object.freeze({
  name: "Classic Robot",
  mode: "robot",
  bands: 16,
  formant: 0,
  q: 4.5,
  attack: 0.008,
  release: 0.06,
  sibilance: 0.4,
  noiseBlend: 0.05,
  dryWet: 1,
  wave: "saw",
  detune: 8,
  unison: 1,
  hold: false,
  monotone: false,
  root: 48,
  chorus: 0.12,
  delayMix: 0.1,
  delayTime: 0.22,
  delayFeedback: 0.28,
  reverb: 0.1,
  gain: 0.9,
  inputGain: 1,
  arp: Object.freeze({
    enabled: false,
    rate: 8,
    pattern: "up",
    octaves: 1,
    gate: 0.62,
  }),
});

const MODE_CHARACTER = Object.freeze({
  robot: {
    wave: "saw",
    unison: 1,
    detune: 7,
    bands: 16,
    formant: 0,
    q: 4.8,
    attack: 0.007,
    release: 0.05,
    sibilance: 0.42,
    noiseBlend: 0.04,
    dryWet: 1,
    chorus: 0.08,
    delayMix: 0.08,
    delayTime: 0.18,
    delayFeedback: 0.22,
    reverb: 0.06,
    monotone: false,
  },
  choir: {
    wave: "supersaw",
    unison: 7,
    detune: 20,
    bands: 24,
    formant: 0,
    q: 3.1,
    attack: 0.035,
    release: 0.2,
    sibilance: 0.14,
    noiseBlend: 0.02,
    dryWet: 0.92,
    chorus: 0.62,
    delayMix: 0.18,
    delayTime: 0.28,
    delayFeedback: 0.32,
    reverb: 0.46,
    monotone: false,
  },
  talkbox: {
    wave: "square",
    unison: 1,
    detune: 4,
    bands: 16,
    formant: 3,
    q: 10,
    attack: 0.004,
    release: 0.032,
    sibilance: 0.06,
    noiseBlend: 0,
    dryWet: 1,
    chorus: 0,
    delayMix: 0.05,
    delayTime: 0.12,
    delayFeedback: 0.18,
    reverb: 0.04,
    monotone: false,
  },
  whisper: {
    wave: "noise",
    unison: 1,
    detune: 0,
    bands: 32,
    formant: 2,
    q: 2.6,
    attack: 0.018,
    release: 0.14,
    sibilance: 0.78,
    noiseBlend: 1,
    dryWet: 0.88,
    chorus: 0.22,
    delayMix: 0.2,
    delayTime: 0.26,
    delayFeedback: 0.3,
    reverb: 0.38,
    monotone: false,
  },
  monotone: {
    wave: "saw",
    unison: 3,
    detune: 10,
    bands: 8,
    formant: -5,
    q: 6,
    attack: 0.01,
    release: 0.08,
    sibilance: 0.48,
    noiseBlend: 0.08,
    dryWet: 1,
    chorus: 0.1,
    delayMix: 0.12,
    delayTime: 0.2,
    delayFeedback: 0.26,
    reverb: 0.1,
    monotone: true,
    root: 45,
  },
});

function clamp(value, min, max) {
  const n = +value;
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

function clampInt(value, min, max) {
  return clamp(Math.round(+value || 0), min, max);
}

export function snapBands(value) {
  const n = +value;
  let best = BAND_CHOICES[0];
  let bestDist = Infinity;
  for (const choice of BAND_CHOICES) {
    const dist = Math.abs(choice - n);
    if (dist < bestDist) {
      best = choice;
      bestDist = dist;
    }
  }
  return best;
}

function onePole(time, sampleRate) {
  const t = Math.max(0.0004, time);
  return 1 - Math.exp(-1 / (t * sampleRate));
}

function fract(value) {
  return value - Math.floor(value);
}

function midiToHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash01(step, seed) {
  let x = Math.imul(step + 1, 374761393) + (seed | 0);
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function polyBlep(t, dt) {
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

function oscSample(shape, phase, dt) {
  if (shape === "square") {
    const s = phase < 0.5 ? 1 : -1;
    return s + polyBlep(phase, dt) - polyBlep(fract(phase + 0.5), dt);
  }
  return 2 * phase - 1 - polyBlep(phase, dt);
}

function designBandpass(sampleRate, freq, q) {
  const nyq = sampleRate * 0.47;
  const f0 = clamp(freq, 30, nyq);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const sin = Math.sin(w0);
  const cos = Math.cos(w0);
  const alpha = sin / (2 * clamp(q, 0.4, 18));
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function designHighpass(sampleRate, freq) {
  const nyq = sampleRate * 0.47;
  const f0 = clamp(freq, 40, nyq);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * 0.707);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function tickBiquad(state, x) {
  const y = state.b0 * x + state.b1 * state.x1 + state.b2 * state.x2 - state.a1 * state.y1 - state.a2 * state.y2;
  if (!Number.isFinite(y)) {
    state.x1 = 0;
    state.x2 = 0;
    state.y1 = 0;
    state.y2 = 0;
    return 0;
  }
  state.x2 = state.x1;
  state.x1 = x;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

export function bandPlan(bands, sampleRate, formantSemitones, q = 4) {
  const count = snapBands(bands);
  const nyq = sampleRate * 0.45;
  const lo = 110;
  const hi = Math.min(6800, nyq * 0.9);
  const shift = 2 ** (clamp(formantSemitones, -12, 12) / 12);
  const plan = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const mod = lo * (hi / lo) ** t;
    let car = mod * shift;
    if (car > nyq) car = nyq;
    if (car < 40) car = 40;
    plan.push({ mod, car, q: clamp(q, 0.8, 14) });
  }
  return plan;
}

export function mergePreset(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  const mode = MODE_IDS.includes(src.mode) ? src.mode : "robot";
  const base = { ...DEFAULTS, ...MODE_CHARACTER[mode], arp: { ...DEFAULTS.arp } };
  const merged = {
    ...base,
    ...src,
    mode,
    arp: { ...base.arp, ...(src.arp || {}) },
  };
  merged.bands = snapBands(merged.bands);
  merged.formant = clamp(merged.formant, -12, 12);
  merged.q = clamp(merged.q, 0.8, 14);
  merged.attack = clamp(merged.attack, 0.001, 0.4);
  merged.release = clamp(merged.release, 0.008, 0.8);
  merged.sibilance = clamp(merged.sibilance, 0, 1);
  merged.noiseBlend = clamp(merged.noiseBlend, 0, 1);
  merged.dryWet = clamp(merged.dryWet, 0, 1);
  merged.wave = WAVE_IDS.includes(merged.wave) ? merged.wave : "saw";
  merged.detune = clamp(merged.detune, 0, 50);
  merged.unison = clampInt(merged.unison, 1, 8);
  merged.hold = Boolean(merged.hold);
  merged.monotone = Boolean(merged.monotone || merged.mode === "monotone");
  merged.root = clampInt(merged.root, 24, 84);
  merged.chorus = clamp(merged.chorus, 0, 1);
  merged.delayMix = clamp(merged.delayMix, 0, 1);
  merged.delayTime = clamp(merged.delayTime, 0.04, 1.2);
  merged.delayFeedback = clamp(merged.delayFeedback, 0, 0.88);
  merged.reverb = clamp(merged.reverb, 0, 1);
  merged.gain = clamp(merged.gain, 0, 1.5);
  merged.inputGain = clamp(merged.inputGain, 0, 2);
  merged.arp.enabled = Boolean(merged.arp.enabled);
  merged.arp.rate = clamp(merged.arp.rate, 0.5, 24);
  merged.arp.pattern = ARP_PATTERNS.includes(merged.arp.pattern) ? merged.arp.pattern : "up";
  merged.arp.octaves = clampInt(merged.arp.octaves, 1, 3);
  merged.arp.gate = clamp(merged.arp.gate, 0.08, 0.98);
  if (typeof merged.name !== "string" || !merged.name.trim()) merged.name = base.name || "Preset";
  return merged;
}

export function applyMode(current, mode) {
  const id = MODE_IDS.includes(mode) ? mode : "robot";
  const character = MODE_CHARACTER[id];
  return mergePreset({
    ...(current || {}),
    ...character,
    mode: id,
    name: current && current.name ? current.name : character.name || DEFAULTS.name,
    arp: { ...((current && current.arp) || {}), ...(character.arp || {}) },
  });
}

export function defaultPreset() {
  return mergePreset({ mode: "robot", name: "Classic Robot" });
}

function resonator(freq, bandwidth, sampleRate) {
  const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
  const w = (2 * Math.PI * freq) / sampleRate;
  return { b1: 2 * r * Math.cos(w), b2: -(r * r), y1: 0, y2: 0 };
}

function tickRes(state, x) {
  const y = x + state.b1 * state.y1 + state.b2 * state.y2;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

export function makeDemoVowel(sampleRate = 44100, seconds = 1.5) {
  const n = Math.max(1, Math.floor(sampleRate * seconds));
  const out = new Float32Array(n);
  const f0 = 130;
  const period = sampleRate / f0;
  const ah = [resonator(730, 90, sampleRate), resonator(1090, 110, sampleRate), resonator(2440, 140, sampleRate)];
  const ee = [resonator(270, 70, sampleRate), resonator(2290, 120, sampleRate), resonator(3010, 150, sampleRate)];
  const rng = mulberry32(0x51a7);
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    phase += 1;
    let excit = 0;
    if (phase >= period) {
      phase -= period;
      excit = 0.85;
    }
    const morph = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    let s = 0;
    for (let k = 0; k < 3; k++) {
      s += tickRes(ah[k], excit) * (1 - morph) + tickRes(ee[k], excit) * morph;
    }
    if (morph > 0.72) {
      const breath = (morph - 0.72) / 0.28;
      s += (rng() * 2 - 1) * breath * breath * 0.55;
    }
    out[i] = s;
    const mag = Math.abs(s);
    if (mag > peak) peak = mag;
  }
  const gain = peak > 1e-8 ? 0.82 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

function slot(engine, index) {
  let item = engine.pool[index];
  if (!item) {
    item = { note: 60, velocity: 0.8, onTime: 0, end: null };
    engine.pool[index] = item;
  }
  return item;
}

function patternIndex(pattern, step, length, seed) {
  if (length <= 1) return 0;
  if (pattern === "down") return length - 1 - (step % length);
  if (pattern === "updown") {
    const cycle = (length - 1) * 2;
    const p = step % cycle;
    return p < length ? p : cycle - p;
  }
  if (pattern === "random") return Math.floor(hash01(step, seed) * length) % length;
  return step % length;
}

function prepareSounding(engine, time) {
  let count = 0;
  if (engine.renderNotes) {
    const list = engine.renderNotes;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const start = +n.start || 0;
      const dur = +n.duration || 0;
      if (time < start || time >= start + dur) continue;
      const s = slot(engine, count++);
      s.note = n.note | 0;
      s.velocity = clamp(n.velocity == null ? 0.85 : n.velocity, 0, 1);
      s.onTime = start;
      s.end = start + dur;
    }
  } else {
    const list = engine.held || [];
    const limit = list.length < 16 ? list.length : 16;
    for (let i = 0; i < limit; i++) {
      const n = list[i];
      const s = slot(engine, count++);
      s.note = n.note | 0;
      s.velocity = clamp(n.velocity == null ? 0.85 : n.velocity, 0, 1);
      s.onTime = +n.onTime || 0;
      s.end = null;
    }
  }

  if (!count) {
    engine.soundCount = 0;
    return;
  }

  const preset = engine.preset;
  if (preset.monotone || preset.mode === "monotone") {
    let vel = 0;
    let onTime = slot(engine, 0).onTime;
    const end = slot(engine, 0).end;
    for (let i = 0; i < count; i++) {
      const s = slot(engine, i);
      if (s.velocity > vel) vel = s.velocity;
      if (s.onTime < onTime) onTime = s.onTime;
    }
    const s0 = slot(engine, 0);
    s0.note = preset.root;
    s0.velocity = vel;
    s0.onTime = onTime;
    s0.end = end;
    count = 1;
  }

  const arp = preset.arp;
  if (arp && arp.enabled) {
    const octaves = arp.octaves;
    const length = count * octaves;
    const rate = arp.rate;
    const stepFloat = time * rate;
    const step = Math.floor(stepFloat);
    const phase = stepFloat - step;
    if (phase >= arp.gate) {
      engine.soundCount = 0;
      return;
    }
    const idx = patternIndex(arp.pattern, step, length, engine.seed);
    const noteIdx = idx % count;
    const octOff = Math.floor(idx / count) * 12;
    const src = slot(engine, noteIdx);
    const note = src.note + octOff;
    const velocity = src.velocity;
    const s0 = slot(engine, 0);
    s0.note = note;
    s0.velocity = velocity;
    s0.onTime = step / rate;
    s0.end = (step + arp.gate) / rate;
    engine.soundCount = 1;
    return;
  }

  engine.soundCount = count;
}

function noteAmp(note, time) {
  const start = note.onTime || 0;
  const age = time - start;
  if (age < 0) return 0;
  const attack = age / 0.005;
  let amp = attack > 1 ? 1 : attack;
  if (note.end != null) {
    const remain = note.end - time;
    if (remain < 0.01) amp *= Math.max(0, remain / 0.01);
  }
  return amp * note.velocity;
}

function pitchedCarrier(engine, time) {
  const count = engine.soundCount;
  if (!count) return 0;
  const preset = engine.preset;
  const shape = preset.wave === "square" ? "square" : "saw";
  let voices = preset.unison;
  if (preset.wave === "supersaw" && voices < 5) voices = 5;
  const detune = preset.detune;
  let mix = 0;
  for (let i = 0; i < count; i++) {
    const note = slot(engine, i);
    const amp = noteAmp(note, time);
    if (amp <= 0) continue;
    const baseHz = midiToHz(note.note);
    let sum = 0;
    for (let u = 0; u < voices; u++) {
      const spread = voices <= 1 ? 0 : (u / (voices - 1)) * 2 - 1;
      const hz = baseHz * 2 ** ((spread * detune) / 1200);
      const dt = hz / engine.sampleRate;
      const phase = fract(time * hz);
      sum += oscSample(shape, phase, dt);
    }
    mix += (sum / Math.sqrt(voices)) * amp;
  }
  return (mix / Math.sqrt(count)) * CARRIER_GAIN;
}

function carrierSample(engine, time) {
  const preset = engine.preset;
  prepareSounding(engine, time);
  const sounding = engine.soundCount > 0;
  let synth = 0;
  if (sounding && preset.wave !== "noise") synth = pitchedCarrier(engine, time);
  const wantsNoise = preset.wave === "noise" || preset.noiseBlend > 0.001;
  let noise = 0;
  if (wantsNoise) noise = engine.noise() * 2 - 1;
  if (!sounding) {
    if (preset.noiseBlend >= 0.5 || preset.wave === "noise") return noise * engine.whisperOpen * 0.7;
    return 0;
  }
  if (preset.wave === "noise") return noise * 0.72;
  const blend = preset.noiseBlend;
  return synth * (1 - blend) + noise * blend * 0.72;
}

function buildBands(engine) {
  const preset = engine.preset;
  const plan = bandPlan(preset.bands, engine.sampleRate, preset.formant, preset.q);
  engine.bands = plan.map((band) => ({
    mod: designBandpass(engine.sampleRate, band.mod, band.q),
    car: designBandpass(engine.sampleRate, band.car, band.q),
    env: 0,
  }));
  engine.bandSig = `${preset.bands}|${preset.formant}|${preset.q}|${engine.sampleRate}`;
  engine.sibHp = designHighpass(engine.sampleRate, Math.min(5200, engine.sampleRate * 0.32));
  engine.sibNoiseHp = designHighpass(engine.sampleRate, Math.min(4800, engine.sampleRate * 0.3));
  engine.bandGain = BAND_MAKEUP / Math.sqrt(engine.bands.length);
  if (preset.mode === "talkbox" || preset.q >= 8) engine.bandGain *= 1.35;
  if (preset.monotone || preset.mode === "monotone") engine.bandGain *= 1.7;
}

function syncRuntime(engine) {
  const preset = engine.preset;
  const sr = engine.sampleRate;
  engine.attackCoef = onePole(preset.attack, sr);
  engine.releaseCoef = onePole(preset.release, sr);
  engine.declick = onePole(0.0035, sr);
  const sig = `${preset.bands}|${preset.formant}|${preset.q}|${sr}`;
  if (sig !== engine.bandSig) buildBands(engine);
}

function readVoice(engine, input, index) {
  if (engine.source === "mic") {
    if (!input) return 0;
    const s = input[index];
    return Number.isFinite(s) ? s : 0;
  }
  const buf = engine.voice;
  if (!buf || buf.length === 0) return 0;
  const pos = engine.voicePos;
  const idx = Math.floor(pos);
  if (!engine.loop && idx >= buf.length) return 0;
  const i0 = ((idx % buf.length) + buf.length) % buf.length;
  const frac = pos - idx;
  let sample;
  if (frac < 1e-8) sample = buf[i0];
  else {
    const i1 = engine.loop || i0 + 1 < buf.length ? (i0 + 1) % buf.length : i0;
    sample = buf[i0] * (1 - frac) + buf[i1] * frac;
  }
  engine.voicePos += engine.voiceRate / engine.sampleRate;
  if (engine.loop && buf.length) {
    const len = buf.length;
    while (engine.voicePos >= len) engine.voicePos -= len;
    while (engine.voicePos < 0) engine.voicePos += len;
  }
  return sample;
}

function readFrac(buf, index) {
  const n = buf.length;
  let idx = index % n;
  if (idx < 0) idx += n;
  const i0 = idx | 0;
  const f = idx - i0;
  const i1 = i0 + 1 >= n ? 0 : i0 + 1;
  return buf[i0] * (1 - f) + buf[i1] * f;
}

function chorusTick(engine, x, amount) {
  const c = engine.chorus;
  c.buf[c.i] = x;
  const rate = 0.2 + amount * 1.5;
  c.phase += rate / engine.sampleRate;
  if (c.phase >= 1) c.phase -= 1;
  const lfo = Math.sin(2 * Math.PI * c.phase);
  const delay = (0.012 + amount * 0.004) * engine.sampleRate + lfo * (0.002 + amount * 0.005) * engine.sampleRate;
  const wet = readFrac(c.buf, c.i - delay);
  c.i += 1;
  if (c.i >= c.buf.length) c.i = 0;
  return x * (1 - amount * 0.45) + wet * (0.35 + amount * 0.55);
}

function delayTick(engine, x) {
  const d = engine.delay;
  const preset = engine.preset;
  const samples = preset.delayTime * engine.sampleRate;
  const delayed = readFrac(d.buf, d.i - samples);
  let fb = x + delayed * preset.delayFeedback;
  if (fb > 1.2) fb = 1.2;
  else if (fb < -1.2) fb = -1.2;
  else if (!Number.isFinite(fb)) fb = 0;
  d.buf[d.i] = fb;
  d.i += 1;
  if (d.i >= d.buf.length) d.i = 0;
  const mix = preset.delayMix;
  return x * (1 - mix) + delayed * mix;
}

function reverbTick(engine, x, mix) {
  const r = engine.reverb;
  let acc = 0;
  for (let i = 0; i < r.combs.length; i++) {
    const c = r.combs[i];
    const y = c.buf[c.i];
    const fb = y * c.feedback;
    c.dampState = fb * (1 - c.damp) + c.dampState * c.damp;
    let next = x + c.dampState;
    if (next > 1.2) next = 1.2;
    else if (next < -1.2) next = -1.2;
    else if (!Number.isFinite(next)) next = 0;
    c.buf[c.i] = next;
    c.i += 1;
    if (c.i >= c.buf.length) c.i = 0;
    acc += y;
  }
  acc /= r.combs.length;
  for (let i = 0; i < r.allpasses.length; i++) {
    const a = r.allpasses[i];
    const buf = a.buf[a.i];
    const y = -acc + buf;
    a.buf[a.i] = acc + buf * 0.5;
    a.i += 1;
    if (a.i >= a.buf.length) a.i = 0;
    acc = y;
  }
  return x * (1 - mix) + acc * mix * 0.85;
}

function initFx(engine) {
  const sr = engine.sampleRate;
  const chorusLen = Math.max(64, Math.floor(sr * 0.05));
  engine.chorus = { buf: new Float32Array(chorusLen), i: 0, phase: 0 };
  const delayLen = Math.max(64, Math.floor(sr * 1.6));
  engine.delay = { buf: new Float32Array(delayLen), i: 0 };
  const scale = sr / 44100;
  const combLens = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.max(16, Math.floor(n * scale)));
  const allpassLens = [225, 341, 441, 556].map((n) => Math.max(8, Math.floor(n * scale)));
  engine.reverb = {
    combs: combLens.map((len, i) => ({
      buf: new Float32Array(len),
      i: 0,
      feedback: 0.7 + (i % 3) * 0.015,
      damp: 0.38,
      dampState: 0,
    })),
    allpasses: allpassLens.map((len) => ({ buf: new Float32Array(len), i: 0 })),
  };
}

function vocode(engine, voice, carrier) {
  const bands = engine.bands;
  let sum = 0;
  const attack = engine.attackCoef;
  const release = engine.releaseCoef;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const mod = tickBiquad(band.mod, voice);
    const car = tickBiquad(band.car, carrier);
    const rect = Math.abs(mod);
    const coef = rect > band.env ? attack : release;
    band.env += (rect - band.env) * coef;
    sum += car * band.env;
    const level = engine.bandLevels[i];
    engine.bandLevels[i] = level + (band.env - level) * 0.08;
  }
  sum *= engine.bandGain;
  const preset = engine.preset;
  if (preset.sibilance > 0.001) {
    const hp = tickBiquad(engine.sibHp, voice);
    const rect = Math.abs(hp);
    const coef = rect > engine.sibEnv ? attack : release;
    engine.sibEnv += (rect - engine.sibEnv) * coef;
    const hiss = tickBiquad(engine.sibNoiseHp, engine.noise() * 2 - 1);
    sum += hiss * engine.sibEnv * preset.sibilance * SIB_GAIN;
  }
  if (!Number.isFinite(sum)) return 0;
  return Math.tanh(sum);
}

function processInner(engine, input, output) {
  syncRuntime(engine);
  const preset = engine.preset;
  const n = output.length;
  const dw = preset.dryWet;
  const useFx = preset.chorus > 0.001 || preset.delayMix > 0.001 || preset.reverb > 0.001;
  let blockPeak = 0;
  const vFollow = onePole(0.03, engine.sampleRate);
  for (let i = 0; i < n; i++) {
    const time = engine.time + i / engine.sampleRate;
    let voice = readVoice(engine, input, i) * preset.inputGain;
    if (!Number.isFinite(voice)) voice = 0;
    const mag = Math.abs(voice);
    engine.voiceEnv += (mag - engine.voiceEnv) * vFollow;
    engine.whisperOpen = engine.voiceEnv * 3.2;
    if (engine.whisperOpen > 1) engine.whisperOpen = 1;

    let y;
    if (dw <= 0) {
      y = voice;
    } else {
      let carrier = carrierSample(engine, time);
      engine.declicked += (carrier - engine.declicked) * engine.declick;
      carrier = engine.declicked;
      const wet = vocode(engine, voice, carrier);
      y = dw >= 1 ? wet : voice * (1 - dw) + wet * dw;
    }
    if (useFx) {
      if (preset.chorus > 0.001) y = chorusTick(engine, y, preset.chorus);
      if (preset.delayMix > 0.001) y = delayTick(engine, y);
      if (preset.reverb > 0.001) y = reverbTick(engine, y, preset.reverb);
    }
    y *= preset.gain;
    if (y > 1) y = 1;
    else if (y < -1) y = -1;
    else if (!Number.isFinite(y)) y = 0;
    output[i] = y;
    const abs = y < 0 ? -y : y;
    if (abs > blockPeak) blockPeak = abs;
  }
  engine.time += n / engine.sampleRate;
  const decay = Math.exp(-n / (engine.sampleRate * 0.18));
  engine.peak = blockPeak > engine.peak * decay ? blockPeak : engine.peak * decay;
}

export function createEngine(sampleRate = 44100, preset = {}, options = {}) {
  const rate = sampleRate > 1000 ? sampleRate : 44100;
  const engine = {
    sampleRate: rate,
    preset: mergePreset(preset),
    time: 0,
    held: [],
    renderNotes: null,
    source: "buffer",
    voice: options.voice || (options.skipVoice ? new Float32Array(0) : makeDemoVowel(rate)),
    voiceRate: options.voiceRate || rate,
    voicePos: 0,
    loop: options.loop !== false,
    seed: options.seed == null ? 0xa7e11e : options.seed >>> 0,
    peak: 0,
    bandLevels: new Float32Array(32),
    bands: [],
    bandSig: "",
    sibEnv: 0,
    voiceEnv: 0,
    whisperOpen: 0,
    declicked: 0,
    pool: [],
    soundCount: 0,
    safe: Boolean(options.safe),
    lastError: null,
  };
  engine.noise = mulberry32(engine.seed);
  initFx(engine);
  buildBands(engine);
  return engine;
}

export function setVoiceBuffer(engine, samples, sampleRate, loop = true) {
  engine.voice = samples && samples.length ? samples : new Float32Array(0);
  engine.voiceRate = sampleRate || engine.sampleRate;
  engine.voicePos = 0;
  engine.loop = Boolean(loop);
  engine.source = "buffer";
}

export function processBlock(engine, input, output) {
  if (!engine.safe) {
    processInner(engine, input, output);
    return;
  }
  try {
    processInner(engine, input, output);
  } catch (error) {
    engine.lastError = error;
    output.fill(0);
  }
}

function coerceVoice(voiceBuffer, fallbackRate) {
  if (!voiceBuffer) return { samples: new Float32Array(0), sampleRate: fallbackRate };
  if (voiceBuffer instanceof Float32Array) return { samples: voiceBuffer, sampleRate: fallbackRate };
  if (ArrayBuffer.isView(voiceBuffer)) return { samples: Float32Array.from(voiceBuffer), sampleRate: fallbackRate };
  if (Array.isArray(voiceBuffer)) return { samples: Float32Array.from(voiceBuffer), sampleRate: fallbackRate };
  const raw = voiceBuffer.samples;
  const samples = raw instanceof Float32Array ? raw : Float32Array.from(raw || []);
  return { samples, sampleRate: +voiceBuffer.sampleRate || fallbackRate };
}

/**
 * Offline bounce. voiceBuffer is a Float32Array (44.1 kHz) or { samples, sampleRate }.
 * midiNotes: [{ note, start, duration, velocity? }] in seconds.
 * preset: partial vocoder preset. options.duration / sampleRate / seed / loop are optional.
 */
export function renderVocoded(voiceBuffer, midiNotes, preset, options = {}) {
  const fallbackRate = options.sampleRate || 44100;
  const voice = coerceVoice(voiceBuffer, fallbackRate);
  const sampleRate = options.sampleRate || voice.sampleRate || 44100;
  const notes = Array.isArray(midiNotes) ? midiNotes : [];
  let duration = options.duration;
  if (duration == null) {
    let end = voice.samples.length / (voice.sampleRate || sampleRate);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const stop = (+n.start || 0) + (+n.duration || 0);
      if (stop > end) end = stop;
    }
    duration = end;
  }
  duration = clamp(duration, 0.01, options.maxDuration || 30);
  const length = Math.max(1, Math.floor(duration * sampleRate));
  const engine = createEngine(sampleRate, preset, {
    seed: options.seed,
    skipVoice: true,
    loop: options.loop !== false,
  });
  engine.voice = voice.samples;
  engine.voiceRate = voice.sampleRate || sampleRate;
  engine.loop = options.loop !== false;
  engine.source = "buffer";
  engine.renderNotes = notes;
  const samples = new Float32Array(length);
  const block = 256;
  for (let offset = 0; offset < length; offset += block) {
    processInner(engine, null, samples.subarray(offset, Math.min(length, offset + block)));
  }
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return { sampleRate, samples, peak, bands: engine.preset.bands, preset: engine.preset };
}
