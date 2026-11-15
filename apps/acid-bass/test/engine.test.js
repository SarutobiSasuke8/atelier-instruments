import test from "node:test";
import assert from "node:assert/strict";
import {
  renderAcidPattern,
  randomiseInKey,
  SCALES,
  makeRng,
  patternToMidi,
  flattenPattern,
  normalizeStep,
} from "../engine.js";
import { encodeWav } from "../../../shared/wav-export.js";

function rms(samples) {
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
  return Math.sqrt(acc / samples.length);
}

function peak(samples) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > max) max = a;
  }
  return max;
}

function gated(overrides = {}) {
  const steps = [];
  for (let i = 0; i < 16; i++) {
    steps.push({ gate: false, note: 0, octave: 1, accent: false, slide: false });
  }
  if (overrides.steps) {
    for (const [index, step] of overrides.steps) steps[index] = { ...steps[index], ...step };
  }
  return { steps };
}

const quiet = {
  cutoff: 0.85,
  resonance: 0,
  envMod: 0,
  decay: 0.05,
  accent: 1,
  drive: 0,
  tempo: 120,
  swing: 0,
  sampleRate: 8000,
  waveform: "saw",
};

test("silence when every gate is closed", () => {
  const rendered = renderAcidPattern(gated(), quiet);
  assert.equal(rendered.samples.length, 16000);
  assert.ok(peak(rendered.samples) < 1e-3);
});

test("a gated step is audible and finite", () => {
  const rendered = renderAcidPattern(
    gated({ steps: [[0, { gate: true, note: 0, octave: 0 }]] }),
    quiet,
  );
  assert.ok(rms(rendered.samples) > 0.01);
  for (let i = 0; i < rendered.samples.length; i++) {
    assert.ok(Number.isFinite(rendered.samples[i]));
    assert.ok(Math.abs(rendered.samples[i]) <= 1.01);
  }
});

test("duration matches tempo for one bar of sixteenths", () => {
  const rendered = renderAcidPattern(gated({ steps: [[0, { gate: true }]] }), {
    ...quiet,
    sampleRate: 10000,
    tempo: 120,
  });
  assert.equal(rendered.duration, 2);
  assert.equal(rendered.samples.length, 20000);
});

test("renders are deterministic", () => {
  const pattern = gated({
    steps: [
      [0, { gate: true, note: 0, octave: 1, accent: true }],
      [3, { gate: true, note: 7, octave: 1, slide: true }],
      [4, { gate: true, note: 3, octave: 2 }],
    ],
  });
  const params = { ...quiet, resonance: 0.8, envMod: 0.7, drive: 0.4, swing: 0.3 };
  const a = renderAcidPattern(pattern, params);
  const b = renderAcidPattern(pattern, params);
  assert.equal(a.samples.length, b.samples.length);
  for (let i = 0; i < a.samples.length; i++) assert.equal(a.samples[i], b.samples[i]);
});

test("accent raises energy when the filter is open and dry", () => {
  const plain = renderAcidPattern(
    gated({ steps: [[0, { gate: true, note: 0, octave: 1, accent: false }]] }),
    { ...quiet, accent: 1, decay: 0.4 },
  );
  const accented = renderAcidPattern(
    gated({ steps: [[0, { gate: true, note: 0, octave: 1, accent: true }]] }),
    { ...quiet, accent: 1, decay: 0.4 },
  );
  assert.ok(rms(accented.samples) > rms(plain.samples) * 1.15);
});

test("saw and square are different waveforms", () => {
  const pattern = gated({ steps: [[0, { gate: true, note: 0, octave: 1 }]] });
  const saw = renderAcidPattern(pattern, { ...quiet, waveform: "saw", decay: 0.5 });
  const square = renderAcidPattern(pattern, { ...quiet, waveform: "square", decay: 0.5 });
  let diff = 0;
  for (let i = 0; i < saw.samples.length; i++) diff += Math.abs(saw.samples[i] - square.samples[i]);
  assert.ok(diff > 10);
});

test("slide glides upward instead of jumping", () => {
  const params = {
    ...quiet,
    tempo: 60,
    sampleRate: 16000,
    decay: 0.9,
    cutoff: 1,
    resonance: 0,
    envMod: 0,
    drive: 0,
    waveform: "saw",
  };
  const slide = renderAcidPattern(
    gated({
      steps: [
        [0, { gate: true, note: 0, octave: 1, slide: true }],
        [1, { gate: true, note: 0, octave: 2 }],
      ],
    }),
    params,
  );
  const jump = renderAcidPattern(
    gated({
      steps: [
        [0, { gate: true, note: 0, octave: 1, slide: false }],
        [1, { gate: true, note: 0, octave: 2 }],
      ],
    }),
    params,
  );
  const step = Math.round((60 / 60 / 4) * params.sampleRate);
  const early = zeroCrossRate(slide.samples, step, step + Math.floor(step * 0.35));
  const late = zeroCrossRate(slide.samples, step + Math.floor(step * 0.65), step * 2 - 8);
  const jumped = zeroCrossRate(jump.samples, step, step + Math.floor(step * 0.35));
  assert.ok(late > early * 1.25, `expected glide up, early ${early} late ${late}`);
  assert.ok(jumped > early * 1.2, `jump should already be high, jump ${jumped} slide ${early}`);
});

test("swing delays the off-beat note", () => {
  const steps = [
    [0, { gate: true, note: 0, octave: 1 }],
    [1, { gate: true, note: 7, octave: 1 }],
  ];
  const straight = renderAcidPattern(gated({ steps }), { ...quiet, swing: 0, decay: 0.02 });
  const swung = renderAcidPattern(gated({ steps }), { ...quiet, swing: 1, decay: 0.02 });
  const stepSamples = Math.round(0.125 * quiet.sampleRate);
  const peakStraight = peakIndex(straight.samples, stepSamples - 200, stepSamples + Math.round(stepSamples * 0.4));
  const peakSwing = peakIndex(swung.samples, stepSamples + Math.round(stepSamples * 0.2), stepSamples * 2);
  assert.ok(peakSwing - peakStraight > stepSamples * 0.35);
});

test("pattern chain is the sum of its patterns", () => {
  const pattern = {
    patterns: {
      A: gated({ steps: [[0, { gate: true, note: 0, octave: 1 }]] }),
      B: gated({ steps: [[0, { gate: true, note: 7, octave: 1 }]] }),
    },
    chain: ["A", "B"],
  };
  const rendered = renderAcidPattern(pattern, { ...quiet, sampleRate: 4000, tempo: 120 });
  assert.equal(rendered.duration, 4);
  assert.equal(flattenPattern(pattern).length, 32);
});

test("high resonance and drive stay finite", () => {
  const steps = [];
  for (let i = 0; i < 16; i++) {
    steps.push({ gate: true, note: (i * 5) % 12, octave: i % 3, accent: i % 2 === 0, slide: i % 3 === 0 });
  }
  const rendered = renderAcidPattern(
    { steps },
    {
      waveform: "saw",
      cutoff: 1,
      resonance: 1,
      envMod: 1,
      decay: 1,
      accent: 1,
      drive: 1,
      tempo: 174,
      swing: 0.66,
      sampleRate: 44100,
    },
  );
  for (let i = 0; i < rendered.samples.length; i += 17) {
    assert.ok(Number.isFinite(rendered.samples[i]));
    assert.ok(Math.abs(rendered.samples[i]) <= 1.01);
  }
  assert.ok(peak(rendered.samples) > 0.05);
});

test("randomiseInKey stays inside the scale", () => {
  const rng = makeRng(99);
  const pattern = randomiseInKey({ root: 9, scale: "minor", density: 0.7 }, rng);
  const allowed = new Set(SCALES.minor.map((tone) => (9 + tone) % 12));
  assert.equal(pattern.steps.length, 16);
  let gates = 0;
  for (const step of pattern.steps) {
    assert.ok(allowed.has(step.note));
    assert.ok(step.octave >= 0 && step.octave <= 2);
    if (step.gate) gates += 1;
  }
  assert.ok(gates >= 4);
});

test("normalise wraps notes and clamps octaves", () => {
  const step = normalizeStep({ gate: 1, note: -1, octave: 9, accent: 1, slide: 0 });
  assert.equal(step.note, 11);
  assert.equal(step.octave, 2);
  assert.equal(step.gate, true);
});

test("midi export is a format-0 file with the gated pitches", () => {
  const bytes = patternToMidi(
    gated({
      steps: [
        [0, { gate: true, note: 0, octave: 0, accent: true }],
        [4, { gate: true, note: 7, octave: 1, slide: true }],
        [5, { gate: true, note: 7, octave: 1 }],
      ],
    }),
    { tempo: 120, swing: 0, rootMidi: 36 },
  );
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "MThd");
  assert.equal(String.fromCharCode(...bytes.slice(14, 18)), "MTrk");
  const notes = midiNoteOns(bytes);
  assert.deepEqual(notes.map((n) => n.note), [36, 55, 55]);
  assert.equal(notes[0].velocity, 112);
  assert.equal(notes[1].velocity, 76);
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1.2, -2]), 8000);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(wav.length, 44 + 5 * 2);
});

function zeroCrossRate(samples, start, end) {
  let crosses = 0;
  const a = Math.max(1, start | 0);
  const b = Math.min(samples.length - 1, end | 0);
  for (let i = a; i < b; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) crosses += 1;
  }
  return crosses / Math.max(1, b - a);
}

function peakIndex(samples, start, end) {
  let best = start;
  let max = 0;
  const a = Math.max(0, start | 0);
  const b = Math.min(samples.length, end | 0);
  for (let i = a; i < b; i++) {
    const value = Math.abs(samples[i]);
    if (value > max) {
      max = value;
      best = i;
    }
  }
  return best;
}

function midiNoteOns(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trackLength = view.getUint32(18, false);
  const dataStart = 22;
  const end = dataStart + trackLength;
  let i = dataStart;
  const notes = [];
  while (i < end) {
    let value = 0;
    let byte = 0;
    do {
      byte = bytes[i++];
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    if (i >= end) break;
    const status = bytes[i++];
    if (status === 0xff) {
      const type = bytes[i++];
      let len = 0;
      do {
        byte = bytes[i++];
        len = (len << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      i += len;
      if (type === 0x2f) break;
    } else if (status === 0x90 || status === 0x80) {
      const note = bytes[i++];
      const velocity = bytes[i++];
      if (status === 0x90 && velocity > 0) notes.push({ note, velocity });
    } else if (status >= 0x80 && status <= 0xef) {
      i += status >= 0xc0 && status <= 0xdf ? 1 : 2;
    }
  }
  return notes;
}
