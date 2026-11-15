// Acid Bass Box voice. No DOM, no Web Audio types — safe for node:test
// and for a live ScriptProcessor / AudioWorklet that just calls process().
//
// Pattern:
//   { steps: Step[] }
//   or { patterns: { A, B, C, D }, chain: ["A", "B"] }
// Step: { gate, note (0-11), octave (0-2), accent, slide }
//
// renderAcidPattern(pattern, params) returns
//   { sampleRate, samples: Float32Array, duration }

import { eventsToMidi } from "../../shared/midi.js";

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
};

const ROOT_MIDI = 36;

/** Output ceiling: about -1.06 dBFS. The final tanh stage can never exceed it. */
export const OUTPUT_CEILING = 0.885;

export function resolveParams(input = {}) {
  const waveform = input.waveform === "square" ? "square" : "saw";
  return {
    waveform,
    cutoff: clamp(num(input.cutoff, 0.4), 0, 1),
    resonance: clamp(num(input.resonance, 0.62), 0, 1),
    envMod: clamp(num(input.envMod, 0.7), 0, 1),
    decay: clamp(num(input.decay, 0.36), 0, 1),
    accent: clamp(num(input.accent, 0.78), 0, 1),
    drive: clamp(num(input.drive, 0.28), 0, 1),
    tempo: clamp(num(input.tempo, 124), 40, 240),
    swing: clamp(num(input.swing, 0), 0, 1),
    sampleRate: Math.max(1000, Math.round(num(input.sampleRate, 44100))),
    cycles: Math.max(1, Math.round(num(input.cycles, 1))),
    rootMidi: clamp(Math.round(num(input.rootMidi, ROOT_MIDI)), 0, 96),
  };
}

export function normalizeStep(raw) {
  const src = raw || {};
  const gate = Boolean(src.gate ?? src.on);
  let note = Number(src.note);
  if (!Number.isFinite(note)) note = 0;
  note = ((Math.round(note) % 12) + 12) % 12;
  let octave = Number(src.octave);
  if (!Number.isFinite(octave)) octave = 1;
  octave = clamp(Math.round(octave), 0, 2);
  return {
    gate,
    note,
    octave,
    accent: Boolean(src.accent),
    slide: Boolean(src.slide),
  };
}

export function emptySteps(count = 16) {
  const steps = [];
  for (let i = 0; i < count; i++) {
    steps.push({ gate: false, note: 0, octave: 1, accent: false, slide: false });
  }
  return steps;
}

export function createEmptyPattern() {
  return { steps: emptySteps(16) };
}

export function flattenPattern(pattern, cycles = 1) {
  const once = stepsOf(pattern);
  const times = Math.max(1, cycles | 0);
  if (times === 1) return once;
  const out = [];
  for (let i = 0; i < times; i++) {
    for (const step of once) out.push({ ...step });
  }
  return out;
}

function stepsOf(pattern) {
  if (!pattern) return emptySteps(16);
  if (Array.isArray(pattern)) return pattern.map(normalizeStep);
  if (Array.isArray(pattern.steps)) {
    const steps = pattern.steps.map(normalizeStep);
    return steps.length ? steps : emptySteps(16);
  }
  if (pattern.patterns) {
    const chain = Array.isArray(pattern.chain) && pattern.chain.length
      ? pattern.chain
      : ["A"];
    const out = [];
    for (const id of chain) {
      const slot = pattern.patterns[id] || pattern.patterns[String(id).toUpperCase()];
      const list = Array.isArray(slot) ? slot : slot?.steps;
      const steps = Array.isArray(list) && list.length ? list.map(normalizeStep) : emptySteps(16);
      out.push(...steps);
    }
    return out.length ? out : emptySteps(16);
  }
  return emptySteps(16);
}

export function makeRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Fill a 16-step pattern with gates and pitch classes from a key.
 * `root` is a pitch class 0-11. `rng` is an optional () => 0..1.
 */
export function randomiseInKey({ root = 0, scale = "minor", density = 0.66 } = {}, rng) {
  const rand = rng || Math.random;
  const tones = SCALES[scale] || SCALES.minor;
  const rootPc = ((Math.round(root) % 12) + 12) % 12;
  const steps = [];
  let last = rootPc;
  const howMany = clamp(density, 0.15, 0.95);
  for (let i = 0; i < 16; i++) {
    const downbeat = i % 4 === 0;
    const gate = rand() < (downbeat ? Math.min(0.95, howMany + 0.2) : howMany * 0.85);
    const palette = downbeat ? [0, 0, 2, 4] : [0, 1, 2, 3, 4, Math.min(5, tones.length - 1), tones.length - 1];
    const degree = palette[Math.floor(rand() * palette.length)] % tones.length;
    const note = (rootPc + tones[degree]) % 12;
    const chosen = gate ? note : last;
    let octave = 0;
    const roll = rand();
    if (roll > 0.82) octave = 2;
    else if (roll > 0.28) octave = 1;
    const accent = gate && (i % 8 === 4 || (i % 2 === 0 && rand() < 0.22));
    const slide = gate && rand() < (downbeat ? 0.08 : 0.28);
    steps.push({
      gate: Boolean(gate),
      note: chosen,
      octave,
      accent: Boolean(accent),
      slide: Boolean(slide),
    });
    if (gate) last = note;
  }
  let gates = steps.reduce((n, step) => n + (step.gate ? 1 : 0), 0);
  let guard = 0;
  while (gates < 4 && guard < 16) {
    const step = steps[guard];
    if (!step.gate) {
      step.gate = true;
      gates += 1;
    }
    guard += 1;
  }
  return { steps };
}

export function noteLabel(step) {
  const safe = normalizeStep(step);
  return `${NOTE_NAMES[safe.note]}${2 + safe.octave}`;
}

export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function renderAcidPattern(pattern, params = {}) {
  const resolved = resolveParams(params);
  const steps = flattenPattern(pattern, resolved.cycles);
  const voice = new AcidVoice(resolved.sampleRate);
  voice.load(steps, resolved);
  const total = Math.max(1, voice.loopSamples);
  const samples = new Float32Array(total);
  voice.playing = true;
  voice.slave = false;
  voice.patternSample = 0;
  voice.stepIndex = -1;
  voice.process(samples, 0);
  return {
    sampleRate: resolved.sampleRate,
    samples,
    duration: total / resolved.sampleRate,
  };
}

export function patternToMidi(pattern, params = {}) {
  const resolved = resolveParams(params);
  const steps = flattenPattern(pattern, resolved.cycles);
  const tpq = 96;
  const ticksPerStep = tpq / 4;
  const swingTicks = Math.round(resolved.swing * 0.5 * ticksPerStep);
  const events = [];
  const count = steps.length;
  for (let i = 0; i < count; i++) {
    const step = steps[i];
    if (!step.gate) continue;
    const start = i * ticksPerStep + (i % 2 === 1 ? swingTicks : 0);
    const next = (i + 1) * ticksPerStep + ((i + 1) % 2 === 1 ? swingTicks : 0);
    const patternEnd = count * ticksPerStep;
    const boundary = Math.min(next, patternEnd);
    const span = Math.max(1, boundary - start);
    const slidesForward = step.slide && i + 1 < count && steps[i + 1].gate;
    const duration = slidesForward ? span : Math.max(1, Math.round(span * 0.85));
    const note = clamp(resolved.rootMidi + step.octave * 12 + step.note, 0, 127);
    const velocity = step.accent ? 112 : 76;
    events.push({ tick: start, type: "on", note, velocity });
    events.push({ tick: start + duration, type: "off", note, velocity: 0 });
  }
  return eventsToMidi({
    tempo: resolved.tempo,
    ticksPerQuarter: tpq,
    name: "Acid Bass Box",
    events,
  });
}

export class AcidVoice {
  constructor(sampleRate) {
    this.sampleRate = Math.max(1000, sampleRate | 0);
    this.params = resolveParams({ sampleRate: this.sampleRate });
    this.steps = emptySteps(16);
    this.playing = false;
    this.slave = false;
    this.phase = 0;
    this.currentHz = midiToHz(ROOT_MIDI);
    this.targetHz = this.currentHz;
    this.sliding = false;
    this.filter = [0, 0, 0, 0];
    this.vca = 0;
    this.fenv = 0;
    this.accenting = false;
    this.stepIndex = -1;
    this.patternSample = 0;
    this.stepStarts = [];
    this.loopSamples = 1;
    this.timelineKey = "";
    this.transpose = 0;
    this.liveMidi = null;
    this.heldPrev = null;
    this.queue = [];
    this.clocks = 0;
    this.samplesDone = 0;
    this.lastClockSample = null;
    this.estimatedBpm = 0;
    this.dcX = 0;
    this.dcY = 0;
    this.dcR = Math.exp((-2 * Math.PI * 28) / this.sampleRate);
    this.peak = 0;
    this.patternIds = [];
    this.localIndex = [];
    this.rebuildTimeline();
  }

  load(steps, params) {
    this.steps = steps.map(normalizeStep);
    this.patternIds = this.steps.map(() => "A");
    this.localIndex = this.steps.map((_, i) => i % 16);
    if (params) this.params = resolveParams({ ...params, sampleRate: this.sampleRate });
    this.timelineKey = "";
    this.rebuildTimeline();
    this.patternSample = 0;
    this.stepIndex = -1;
    this.heldPrev = null;
  }

  /** Live program: { patterns, chain } plus synth params. Keeps playhead if it can. */
  sync(program, params) {
    const chain = program.chain?.length ? program.chain : [program.edit || "A"];
    const steps = [];
    const patternIds = [];
    const localIndex = [];
    for (const id of chain) {
      const slot = program.patterns?.[id];
      const list = slot?.steps?.length ? slot.steps : emptySteps(16);
      list.forEach((step, index) => {
        steps.push(normalizeStep(step));
        patternIds.push(id);
        localIndex.push(index);
      });
    }
    this.steps = steps.length ? steps : emptySteps(16);
    this.patternIds = patternIds.length ? patternIds : this.steps.map(() => "A");
    this.localIndex = localIndex.length ? localIndex : this.steps.map((_, i) => i);
    this.params = resolveParams({ ...params, sampleRate: this.sampleRate });
    this.timelineKey = "";
    const previous = this.patternSample;
    this.rebuildTimeline();
    if (previous >= this.loopSamples) this.patternSample = 0;
  }

  setTranspose(semitones) {
    this.transpose = clamp(Math.round(semitones || 0), -24, 24);
  }

  noteOn(midi, { transposeBase = 48 } = {}) {
    const note = clamp(Math.round(midi), 0, 127);
    if (this.playing) {
      this.transpose = clamp(note - transposeBase, -24, 24);
      return;
    }
    this.liveMidi = note;
    this.targetHz = midiToHz(note);
    this.currentHz = this.targetHz;
    this.sliding = false;
    this.trigger(false);
  }

  noteOff(midi) {
    if (this.playing) {
      if (this.transpose === clamp(Math.round(midi) - 48, -24, 24)) this.transpose = 0;
      return;
    }
    if (this.liveMidi === midi) this.liveMidi = null;
  }

  releaseLive() {
    if (this.playing) this.transpose = 0;
    else this.liveMidi = null;
  }

  start() {
    this.slave = false;
    this.playing = true;
    this.patternSample = 0;
    this.stepIndex = -1;
    this.heldPrev = null;
    this.clocks = 0;
  }

  stop() {
    this.playing = false;
    this.slave = false;
    this.stepIndex = -1;
    this.clocks = 0;
    this.transpose = 0;
  }

  armSlave() {
    this.playing = true;
    this.slave = true;
    this.clocks = 0;
    this.stepIndex = -1;
    this.patternSample = 0;
    this.heldPrev = null;
    this.lastClockSample = null;
  }

  schedule(time, type) {
    const event = { time, type };
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].time > time) i -= 1;
    this.queue.splice(i, 0, event);
    if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64);
  }

  process(output, time0 = 0) {
    const sr = this.sampleRate;
    for (let i = 0; i < output.length; i++) {
      const time = time0 + i / sr;
      this.consume(time);
      if (this.playing && !this.slave) this.advanceInternal();
      output[i] = this.synthSample();
      this.samplesDone += 1;
    }
  }

  advanceInternal() {
    if (this.patternSample >= this.loopSamples) {
      this.heldPrev = this.steps[this.steps.length - 1] || null;
      this.patternSample = 0;
      this.stepIndex = -1;
    }
    const next = this.stepIndex + 1;
    if (next < this.steps.length && this.patternSample === this.stepStarts[next]) {
      this.fireStep(next);
    }
    this.patternSample += 1;
  }

  consume(time) {
    while (this.queue.length && this.queue[0].time <= time + 1e-5) {
      const event = this.queue.shift();
      if (event.type === "start" || event.type === "continue") this.armSlave();
      else if (event.type === "stop") this.stop();
      else if (event.type === "clock") this.onSlaveClock();
    }
  }

  onSlaveClock() {
    if (this.lastClockSample != null) {
      const dt = (this.samplesDone - this.lastClockSample) / this.sampleRate;
      if (dt > 0.004 && dt < 0.08) {
        const bpm = 60 / (dt * 24);
        this.estimatedBpm = this.estimatedBpm ? this.estimatedBpm * 0.85 + bpm * 0.15 : bpm;
      }
    }
    this.lastClockSample = this.samplesDone;
    if (!this.playing || !this.slave) return;
    this.clocks += 1;
    if ((this.clocks - 1) % 6 === 0) {
      let next = this.stepIndex + 1;
      if (next >= this.steps.length) {
        this.heldPrev = this.steps[this.steps.length - 1] || null;
        next = 0;
      }
      this.fireStep(next);
    }
  }

  fireStep(index) {
    const prev = this.stepIndex >= 0 ? this.steps[this.stepIndex] : this.heldPrev;
    this.stepIndex = index;
    this.heldPrev = null;
    const step = this.steps[index];
    if (!step) return;
    const sliding = Boolean(prev && prev.slide && prev.gate && step.gate);
    this.sliding = sliding;
    this.targetHz = midiToHz(this.midiFor(step));
    if (!step.gate) {
      this.sliding = false;
      return;
    }
    if (!sliding) {
      this.currentHz = this.targetHz;
      this.trigger(step.accent);
    } else if (step.accent) {
      this.fenv = Math.max(this.fenv, 0.8);
      this.accenting = true;
    }
  }

  midiFor(step) {
    return clamp(this.params.rootMidi + step.octave * 12 + step.note + this.transpose, 0, 127);
  }

  trigger(accent) {
    this.accenting = Boolean(accent);
    this.vca = accent ? 0.72 + 0.28 * this.params.accent : 0.58;
    this.fenv = 1;
  }

  synthSample() {
    if (!this.playing && this.liveMidi != null) {
      this.targetHz = midiToHz(this.liveMidi);
      if (!this.sliding) this.currentHz = this.targetHz;
    } else if (this.playing && this.stepIndex >= 0) {
      const step = this.steps[this.stepIndex];
      if (step) this.targetHz = midiToHz(this.midiFor(step));
    }

    if (this.sliding) {
      const coeff = 1 - Math.exp(-1 / (0.065 * this.sampleRate));
      this.currentHz += (this.targetHz - this.currentHz) * coeff;
    } else {
      this.currentHz = this.targetHz;
    }

    const dt = this.currentHz / this.sampleRate;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    const osc = this.params.waveform === "square" ? square(this.phase, dt) : saw(this.phase, dt);

    const decayBase = decaySeconds(this.params.decay);
    const decay = Math.max(0.012, this.accenting ? decayBase * 0.58 : decayBase);
    const coef = Math.exp(-1 / (decay * this.sampleRate));
    this.vca *= coef;
    this.fenv *= coef;

    const envScale = this.accenting ? 1 + this.params.accent * 2.1 : 1;
    const cutoff = cutoffHz(this.params.cutoff) + this.fenv * this.params.envMod * envScale * 7200;
    const driven = Math.tanh(osc * (0.85 + this.params.drive * 4.2));
    let y = ladder(driven, cutoff, this.params.resonance, this.sampleRate, this.filter);
    const amp = this.vca * (this.accenting ? 0.42 + 0.7 * this.params.accent : 0.3);
    y *= amp;
    y = this.dcBlock(y);
    // Soft-limit into a fixed ceiling so hot presets cannot reach full scale.
    y = OUTPUT_CEILING * Math.tanh(y * (1.05 + this.params.drive * 1.4));
    const abs = Math.abs(y);
    const release = Math.exp(-1 / (0.16 * this.sampleRate));
    this.peak = Math.max(abs, this.peak * release);
    return y;
  }

  dcBlock(x) {
    const y = x - this.dcX + this.dcR * this.dcY;
    this.dcX = x;
    this.dcY = y;
    return y;
  }

  rebuildTimeline() {
    const key = `${this.params.tempo}|${this.params.swing}|${this.steps.length}|${this.sampleRate}`;
    if (key === this.timelineKey && this.stepStarts.length === this.steps.length) return;
    this.timelineKey = key;
    const built = buildTimeline(this.steps.length, this.params, this.sampleRate);
    this.stepStarts = built.starts;
    this.loopSamples = built.total;
  }

  get playhead() {
    const index = this.stepIndex;
    if (index < 0) {
      return { step: -1, patternId: this.patternIds[0] || "A", local: -1 };
    }
    return {
      step: index,
      patternId: this.patternIds[index] || "A",
      local: this.localIndex[index] ?? index % 16,
    };
  }
}

function buildTimeline(count, params, sampleRate) {
  const safeCount = Math.max(1, count | 0);
  const stepSec = 60 / params.tempo / 4;
  const swingDelay = params.swing * 0.5 * stepSec;
  const starts = [];
  for (let i = 0; i < safeCount; i++) {
    const base = i * stepSec;
    const start = i % 2 === 1 ? base + swingDelay : base;
    let sample = Math.round(start * sampleRate);
    if (i > 0 && sample <= starts[i - 1]) sample = starts[i - 1] + 1;
    starts.push(sample);
  }
  let total = Math.round(safeCount * stepSec * sampleRate);
  if (total <= starts[starts.length - 1]) total = starts[starts.length - 1] + 1;
  return { starts, total };
}

function cutoffHz(amount) {
  const min = Math.log(70);
  const max = Math.log(6800);
  return Math.exp(min + clamp(amount, 0, 1) * (max - min));
}

function decaySeconds(amount) {
  return 0.045 + Math.pow(clamp(amount, 0, 1), 1.55) * 1.25;
}

function saw(phase, dt) {
  return 2 * phase - 1 - polyBlep(phase, dt);
}

function square(phase, dt) {
  let value = phase < 0.5 ? 1 : -1;
  value += polyBlep(phase, dt);
  let shifted = phase + 0.5;
  if (shifted >= 1) shifted -= 1;
  value -= polyBlep(shifted, dt);
  return value;
}

function polyBlep(t, dt) {
  if (!(dt > 0) || dt >= 1) return 0;
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

function ladder(input, cutoff, resonance, sampleRate, state) {
  const fc = Math.min(Math.max(cutoff, 25), sampleRate * 0.42);
  let g = Math.tan((Math.PI * fc) / sampleRate);
  if (!Number.isFinite(g) || g > 6) g = 6;
  const k = clamp(resonance, 0, 1) * 3.45;
  let x = Math.tanh(input - k * state[3]);
  const gNorm = g / (1 + g);
  for (let i = 0; i < 4; i++) {
    const v = gNorm * (x - state[i]);
    const y = v + state[i];
    state[i] = y + v;
    if (!Number.isFinite(state[i]) || Math.abs(state[i]) > 12) state[i] = 0;
    x = state[i];
  }
  return x;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
