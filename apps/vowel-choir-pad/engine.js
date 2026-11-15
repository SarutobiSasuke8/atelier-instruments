/**
 * Vowel choir synthesizer.
 * No DOM and no Web Audio — render() writes stereo buffers offline.
 */

export const VOWELS = Object.freeze([
  Object.freeze({ id: 'ooh', label: 'ooh', x: 0.18, y: 0.24, f: [340, 760, 2400, 3400], bw: [60, 80, 140, 200], a: [1, 0.28, 0.1, 0.05] }),
  Object.freeze({ id: 'oh', label: 'oh', x: 0.32, y: 0.5, f: [470, 820, 2500, 3500], bw: [70, 80, 140, 200], a: [1, 0.36, 0.12, 0.05] }),
  Object.freeze({ id: 'ah', label: 'ah', x: 0.5, y: 0.78, f: [760, 1180, 2700, 3600], bw: [90, 100, 150, 220], a: [1, 0.55, 0.18, 0.07] }),
  Object.freeze({ id: 'eh', label: 'eh', x: 0.7, y: 0.46, f: [530, 1760, 2600, 3700], bw: [60, 90, 150, 220], a: [0.75, 0.85, 0.22, 0.08] }),
  Object.freeze({ id: 'ee', label: 'ee', x: 0.84, y: 0.2, f: [300, 2280, 3100, 3900], bw: [45, 80, 160, 220], a: [0.42, 1, 0.32, 0.1] }),
]);

export const SWEEP_LOOP = Object.freeze([
  Object.freeze({ x: 0.18, y: 0.24 }),
  Object.freeze({ x: 0.32, y: 0.5 }),
  Object.freeze({ x: 0.5, y: 0.78 }),
  Object.freeze({ x: 0.7, y: 0.46 }),
  Object.freeze({ x: 0.84, y: 0.2 }),
  Object.freeze({ x: 0.58, y: 0.16 }),
  Object.freeze({ x: 0.36, y: 0.16 }),
  Object.freeze({ x: 0.18, y: 0.24 }),
]);

export const PRESET_SPEC = Object.freeze({
  name: { type: 'string', default: 'Custom', maxLength: 48 },
  vowelX: { type: 'number', min: 0, max: 1, default: 0.5 },
  vowelY: { type: 'number', min: 0, max: 1, default: 0.78 },
  choirSize: { type: 'number', integer: true, min: 1, max: 8, default: 6 },
  breathiness: { type: 'number', min: 0, max: 1, default: 0.26 },
  vibrato: { type: 'number', min: 0, max: 1, default: 0.38 },
  vibratoRate: { type: 'number', min: 3, max: 8, default: 5 },
  reverb: { type: 'number', min: 0, max: 1, default: 0.7 },
  sweep: { type: 'boolean', default: false },
  sweepRate: { type: 'number', min: 0.03, max: 0.45, default: 0.08 },
});

export function applyPatch(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, rule] of Object.entries(PRESET_SPEC)) {
    const value = source[key];
    if (rule.type === "number") {
      const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      const next = Number.isFinite(numeric) ? numeric : rule.default;
      const bounded = clamp(next, rule.min, rule.max);
      out[key] = rule.integer ? Math.round(bounded) : bounded;
    } else if (rule.type === "boolean") {
      if (typeof value === "boolean") out[key] = value;
      else if (value === "true" || value === 1) out[key] = true;
      else if (value === "false" || value === 0) out[key] = false;
      else out[key] = Boolean(rule.default);
    } else if (rule.type === "string") {
      const text = typeof value === "string" ? value.trim() : "";
      out[key] = (text || rule.default || "").slice(0, rule.maxLength || 80);
    }
  }
  return out;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function singerLayout(count) {
  const n = clamp(Math.round(Number(count) || 1), 1, 8);
  const singers = [];
  for (let i = 0; i < n; i++) {
    const center = (n - 1) / 2;
    const t = n === 1 ? 0.5 : i / (n - 1);
    singers.push({
      cents: (i - center) * (5.2 + n * 0.4),
      pan: (t * 2 - 1) * (n === 1 ? 0 : 0.75),
      fMul: [
        1 + (i - center) * 0.01,
        1 + (i - center) * 0.018,
        1 - (i - center) * 0.012,
        1 + ((i % 3) - 1) * 0.01,
      ],
      vibPhase: (i * 1.7) % (Math.PI * 2),
      vibRateScale: 0.92 + (i % 5) * 0.035,
      delay: i * 0.012,
      attack: 0.055 + (i % 4) * 0.014,
    });
  }
  return singers;
}

export function timbreAt(x, y) {
  const X = clamp(x, 0, 1);
  const Y = clamp(y, 0, 1);
  const accF = [0, 0, 0, 0];
  const accBw = [0, 0, 0, 0];
  const accA = [0, 0, 0, 0];
  let wsum = 0;
  let nearest = VOWELS[0];
  let best = Infinity;
  for (const vowel of VOWELS) {
    const dx = X - vowel.x;
    const dy = Y - vowel.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      nearest = vowel;
    }
    const w = 1 / (d2 * d2 + 1e-8);
    wsum += w;
    for (let i = 0; i < 4; i++) {
      accF[i] += w * vowel.f[i];
      accBw[i] += w * vowel.bw[i];
      accA[i] += w * vowel.a[i];
    }
  }
  const aSum = accA[0] + accA[1] + accA[2] + accA[3] || 1;
  return {
    f: accF.map((v) => v / wsum),
    bw: accBw.map((v) => v / wsum),
    a: accA.map((v) => v / aSum),
    vowel: nearest.id,
    label: nearest.label,
  };
}

export function sweepPoint(phase) {
  const spans = SWEEP_LOOP.length - 1;
  let u = phase % 1;
  if (u < 0) u += 1;
  const scaled = u * spans;
  let index = Math.floor(scaled);
  if (index >= spans) index = spans - 1;
  const t = scaled - index;
  const a = SWEEP_LOOP[index];
  const b = SWEEP_LOOP[index + 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function vowelPosition(time, options) {
  if (!options.sweep) return { x: options.vowelX, y: options.vowelY };
  return sweepPoint(time * (options.sweepRate || 0.08));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function setBandpass(coeff, freq, bw, sampleRate) {
  const nyquist = sampleRate * 0.45;
  const f = clamp(freq, 70, nyquist);
  const q = clamp(f / Math.max(24, bw), 0.7, 18);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  coeff.b0 = alpha / a0;
  coeff.b1 = 0;
  coeff.b2 = -alpha / a0;
  coeff.a1 = (-2 * cos) / a0;
  coeff.a2 = (1 - alpha) / a0;
}

function stepBiquad(coeff, state, x) {
  const y = coeff.b0 * x + state.z1;
  state.z1 = coeff.b1 * x - coeff.a1 * y + state.z2;
  state.z2 = coeff.b2 * x - coeff.a2 * y;
  return y;
}

function envelopeAt(time, start, end, delay, attack, release) {
  const u = time - start - delay;
  if (u < 0) return 0;
  const held = Math.max(0, end - start);
  if (u >= held + release) return 0;
  let amp = u < attack ? u / Math.max(0.001, attack) : 1;
  amp = amp * amp * (3 - 2 * amp);
  if (u > held) {
    const r = (u - held) / Math.max(0.001, release);
    amp *= (1 - r) * (1 - r);
  }
  return amp;
}

function combInto(input, output, sampleRate, delaySec, feedback, damp) {
  const delay = Math.max(1, Math.round(delaySec * sampleRate));
  const buf = new Float32Array(delay);
  let index = 0;
  let low = 0;
  for (let i = 0; i < input.length; i++) {
    const delayed = buf[index];
    low = delayed * (1 - damp) + low * damp;
    buf[index] = input[i] + low * feedback;
    output[i] += delayed;
    index += 1;
    if (index >= delay) index = 0;
  }
}

function allpass(input, sampleRate, delaySec, gain) {
  const delay = Math.max(1, Math.round(delaySec * sampleRate));
  const buf = new Float32Array(delay);
  const out = new Float32Array(input.length);
  let index = 0;
  for (let i = 0; i < input.length; i++) {
    const delayed = buf[index];
    const v = input[i] + delayed * gain;
    buf[index] = v;
    out[i] = delayed - gain * v;
    index += 1;
    if (index >= delay) index = 0;
  }
  return out;
}

function applyReverb(left, right, sampleRate, amount) {
  const wet = clamp(amount, 0, 1);
  if (wet < 0.001 || left.length === 0) return;
  const revL = new Float32Array(left.length);
  const revR = new Float32Array(right.length);
  const combs = [
    [0.0297, 0.0371, 0.0411, 0.0437],
    [0.0313, 0.0389, 0.0427, 0.0461],
  ];
  const feedback = 0.72 + wet * 0.12;
  const damp = 0.28;
  for (let c = 0; c < 4; c++) {
    combInto(left, revL, sampleRate, combs[0][c], feedback, damp);
    combInto(right, revR, sampleRate, combs[1][c], feedback, damp);
  }
  let wetL = allpass(revL, sampleRate, 0.0051, 0.7);
  let wetR = allpass(revR, sampleRate, 0.0063, 0.7);
  wetL = allpass(wetL, sampleRate, 0.0017, 0.65);
  wetR = allpass(wetR, sampleRate, 0.0021, 0.65);
  const wetGain = wet * 0.22;
  const dryGain = 1 - wet * 0.22;
  for (let i = 0; i < left.length; i++) {
    left[i] = left[i] * dryGain + wetL[i] * wetGain;
    right[i] = right[i] * dryGain + wetR[i] * wetGain;
  }
}

function normalizeOptions(options) {
  const sampleRate = clamp(options.sampleRate || 44100, 8000, 96000);
  const duration = clamp(options.duration ?? 1, 0, 30);
  const choirSize = clamp(Math.round(options.choirSize || 6), 1, 8);
  return {
    sampleRate,
    duration,
    choirSize,
    vowelX: clamp(options.vowelX ?? 0.5, 0, 1),
    vowelY: clamp(options.vowelY ?? 0.78, 0, 1),
    sweep: Boolean(options.sweep),
    sweepRate: clamp(options.sweepRate ?? 0.08, 0.01, 2),
    breathiness: clamp(options.breathiness ?? 0.2, 0, 1),
    vibrato: clamp(options.vibrato ?? 0.3, 0, 1),
    vibratoRate: clamp(options.vibratoRate ?? 5.1, 0.2, 12),
    reverb: clamp(options.reverb ?? 0, 0, 1),
    gain: clamp(options.gain ?? 0.85, 0, 1.5),
    seed: (options.seed ?? 1) >>> 0,
    notes: Array.isArray(options.notes) ? options.notes.slice(0, 16) : [],
  };
}

/**
 * @param {object} options
 * @param {number} options.sampleRate
 * @param {number} options.duration seconds
 * @param {{midi:number, velocity?:number, start?:number, end?:number}[]} options.notes
 * @returns {{sampleRate:number, left:Float32Array, right:Float32Array}}
 */
export function render(options = {}) {
  const opts = normalizeOptions(options);
  const { sampleRate } = opts;
  const frames = Math.floor(opts.duration * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  if (frames === 0 || opts.notes.length === 0) {
    return { sampleRate, left, right };
  }

  const layout = singerLayout(opts.choirSize);
  const level = (opts.gain * 1.15) / Math.sqrt(layout.length);
  const release = 0.34;
  const rand = mulberry32(opts.seed || 1);
  const voices = [];

  for (const note of opts.notes) {
    const midi = Number(note.midi);
    const velocity = clamp(note.velocity == null ? 0.85 : Number(note.velocity), 0, 1);
    if (!Number.isFinite(midi) || velocity <= 0) continue;
    const start = Math.max(0, note.start ?? 0);
    const end = note.end == null ? opts.duration + release : Math.max(start, note.end);
    if (start >= opts.duration) continue;
    for (let s = 0; s < layout.length; s++) {
      const spec = layout[s];
      const noise = mulberry32((opts.seed + 1 + voices.length * 17 + Math.round(midi) * 13) >>> 0);
      voices.push({
        midi,
        velocity,
        start,
        end,
        spec,
        phase: rand(),
        lp: 0,
        noiseState: noise,
        noiseValue: 0,
        vib: spec.vibPhase,
        dcX: 0,
        dcY: 0,
        filters: [0, 1, 2, 3].map(() => ({ z1: 0, z2: 0 })),
        coeffs: [0, 1, 2, 3].map(() => ({ b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 })),
      });
    }
  }

  const block = 64;
  const lpCoef = Math.exp((-2 * Math.PI * 1600) / sampleRate);
  for (let pos = 0; pos < frames; pos += block) {
    const time = pos / sampleRate;
    const place = vowelPosition(time, opts);
    const timbre = timbreAt(place.x, place.y);
    const endFrame = Math.min(frames, pos + block);
    for (const voice of voices) {
      const { spec } = voice;
      for (let k = 0; k < 4; k++) {
        setBandpass(voice.coeffs[k], timbre.f[k] * spec.fMul[k], timbre.bw[k], sampleRate);
      }
      const baseHz = midiToHz(voice.midi) * 2 ** (spec.cents / 1200);
      const vibDepth = opts.vibrato * 0.02 * spec.vibRateScale;
      const vibInc = (2 * Math.PI * opts.vibratoRate * spec.vibRateScale) / sampleRate;
      const toneMix = 1 - opts.breathiness * 0.7;
      const noiseMix = opts.breathiness * 0.85;
      const pan = spec.pan;
      const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
      const panL = Math.cos(angle);
      const panR = Math.sin(angle);
      const peak = level * voice.velocity;
      for (let i = pos; i < endFrame; i++) {
        const t = i / sampleRate;
        const env = envelopeAt(t, voice.start, voice.end, spec.delay, spec.attack, release);
        if (env <= 0) continue;
        voice.vib += vibInc;
        const hz = clamp(baseHz * (1 + vibDepth * Math.sin(voice.vib)), 20, sampleRate * 0.45);
        const dt = hz / sampleRate;
        voice.phase += dt;
        if (voice.phase >= 1) voice.phase -= 1;
        let saw = 2 * voice.phase - 1;
        saw -= polyBlep(voice.phase, dt);
        const shaped = saw - 0.12 * saw * saw * saw;
        voice.lp += (1 - lpCoef) * (shaped - voice.lp);
        const white = voice.noiseState() * 2 - 1;
        voice.noiseValue = voice.noiseValue * 0.7 + white * 0.3;
        const src = toneMix * voice.lp + noiseMix * voice.noiseValue;
        let formed = 0;
        for (let k = 0; k < 4; k++) {
          formed += stepBiquad(voice.coeffs[k], voice.filters[k], src) * timbre.a[k];
        }
        const dc = formed - voice.dcX + 0.995 * voice.dcY;
        voice.dcX = formed;
        voice.dcY = dc;
        const sample = dc * env * peak * 2.4;
        left[i] += sample * panL;
        right[i] += sample * panR;
      }
    }
  }

  applyReverb(left, right, sampleRate, opts.reverb);
  const fade = Math.max(1, Math.floor(sampleRate * 0.008));
  for (let i = 0; i < frames; i++) {
    let tail = 1;
    if (i > frames - fade) tail = (frames - 1 - i) / fade;
    left[i] = Math.tanh(left[i] * tail);
    right[i] = Math.tanh(right[i] * tail);
  }
  return { sampleRate, left, right };
}
