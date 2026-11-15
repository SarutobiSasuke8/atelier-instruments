import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeWav } from "../../../shared/wav-export.js";
import {
  PRESET_SPEC,
  SWEEP_LOOP,
  VOWELS,
  applyPatch,
  render,
  singerLayout,
  sweepPoint,
  timbreAt,
} from "../engine.js";

const presetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');

function rms(buffer, start = 0, end = buffer.length) {
  let energy = 0;
  const a = Math.max(0, start);
  const b = Math.min(buffer.length, end);
  for (let i = a; i < b; i++) energy += buffer[i] * buffer[i];
  return Math.sqrt(energy / Math.max(1, b - a));
}

function goertzel(buffer, sampleRate, freq, i0, i1) {
  const n = i1 - i0;
  const k = Math.round((freq * n) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    const s0 = buffer[i0 + i] * hann + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function bandRatio(buffer, sampleRate) {
  const i0 = Math.floor(buffer.length * 0.25);
  const i1 = Math.floor(buffer.length * 0.9);
  const low = [500, 700, 900].reduce((sum, freq) => sum + goertzel(buffer, sampleRate, freq, i0, i1), 0);
  const high = [1800, 2100, 2400, 2700].reduce((sum, freq) => sum + goertzel(buffer, sampleRate, freq, i0, i1), 0);
  return high / (low + 1e-12);
}

function periodicity(buffer, sampleRate, freq) {
  const lag = Math.round(sampleRate / freq);
  const i0 = Math.floor(buffer.length * 0.35);
  const i1 = Math.floor(buffer.length * 0.85) - lag;
  let acc = 0;
  let aa = 0;
  let bb = 0;
  for (let i = i0; i < i1; i++) {
    acc += buffer[i] * buffer[i + lag];
    aa += buffer[i] * buffer[i];
    bb += buffer[i + lag] * buffer[i + lag];
  }
  return acc / Math.sqrt(aa * bb + 1e-12);
}

const base = {
  sampleRate: 16000,
  duration: 0.45,
  choirSize: 1,
  breathiness: 0,
  vibrato: 0,
  reverb: 0,
  gain: 0.9,
  seed: 3,
  notes: [{ midi: 57, velocity: 0.9, start: 0.02, end: 0.4 }],
};

test('anchors land on their own formants', () => {
  for (const vowel of VOWELS) {
    const timbre = timbreAt(vowel.x, vowel.y);
    assert.equal(timbre.vowel, vowel.id);
    assert.ok(Math.abs(timbre.f[0] - vowel.f[0]) < 8, `${vowel.id} F1`);
    assert.ok(Math.abs(timbre.f[1] - vowel.f[1]) < 8, `${vowel.id} F2`);
  }
  assert.ok(timbreAt(0.84, 0.2).f[1] > timbreAt(0.18, 0.24).f[1] + 1000);
});

test('sweep loop leaves the starting vowel', () => {
  const start = sweepPoint(0);
  const mid = sweepPoint(0.35);
  assert.ok(Math.abs(start.x - SWEEP_LOOP[0].x) < 1e-6);
  assert.ok(Math.hypot(mid.x - start.x, mid.y - start.y) > 0.2);
  assert.equal(singerLayout(1).length, 1);
  assert.equal(singerLayout(8).length, 8);
  assert.equal(singerLayout(40).length, 8);
});

test('silence, finite samples, and deterministic length', () => {
  const silent = render({ ...base, notes: [] });
  assert.equal(silent.left.length, Math.floor(0.45 * 16000));
  assert.equal(rms(silent.left), 0);
  const voiced = render(base);
  assert.equal(voiced.left.length, voiced.right.length);
  assert.ok(rms(voiced.left) > 0.02);
  for (let i = 0; i < voiced.left.length; i += 17) {
    assert.ok(Number.isFinite(voiced.left[i]) && Number.isFinite(voiced.right[i]));
    assert.ok(Math.abs(voiced.left[i]) <= 1);
  }
  const again = render(base);
  assert.equal(again.left[1000], voiced.left[1000]);
});

test('ee carries more upper formant energy than ooh', () => {
  const ooh = VOWELS.find((vowel) => vowel.id === 'ooh');
  const ee = VOWELS.find((vowel) => vowel.id === 'ee');
  const low = render({ ...base, vowelX: ooh.x, vowelY: ooh.y });
  const high = render({ ...base, vowelX: ee.x, vowelY: ee.y });
  assert.ok(bandRatio(high.left, 16000) > bandRatio(low.left, 16000) * 1.4);
});

test('breath loosens a pure tone and choir size changes the stack', () => {
  const pure = render(base);
  const breathy = render({ ...base, breathiness: 1, seed: 9 });
  const hz = 440 * 2 ** ((57 - 69) / 12);
  assert.ok(periodicity(pure.left, 16000, hz) > periodicity(breathy.left, 16000, hz) + 0.15);
  const choir = render({ ...base, choirSize: 8, duration: 0.35 });
  let diff = 0;
  const n = Math.min(choir.left.length, pure.left.length);
  for (let i = 0; i < n; i += 8) diff += Math.abs(choir.left[i] - pure.left[i]);
  assert.ok(diff > 1);
});

test('vibrato bends pitch across a cycle', () => {
  const sampleRate = 16000;
  const expectLag = Math.round(sampleRate / 220);
  function bestLag(buffer, i0, i1) {
    let best = -Infinity;
    let lagAt = expectLag;
    for (let lag = expectLag - 8; lag <= expectLag + 8; lag++) {
      let acc = 0;
      for (let i = i0; i < i1 - lag; i++) acc += buffer[i] * buffer[i + lag];
      if (acc > best) {
        best = acc;
        lagAt = lag;
      }
    }
    return lagAt;
  }
  const notes = [{ midi: 57, velocity: 0.9, start: 0, end: 0.8 }];
  const still = render({ ...base, duration: 0.8, vibrato: 0, notes });
  const wide = render({ ...base, duration: 0.8, vibrato: 1, vibratoRate: 5, notes });
  const a = Math.floor(0.12 * sampleRate);
  const b = Math.floor(0.22 * sampleRate);
  const c = Math.floor(0.22 * sampleRate);
  const d = Math.floor(0.32 * sampleRate);
  assert.equal(bestLag(still.left, a, b), bestLag(still.left, c, d));
  assert.ok(Math.abs(bestLag(wide.left, a, b) - bestLag(wide.left, c, d)) >= 2);
});

test('a finished note is quieter than the sustain, and reverb keeps a tail', () => {
  const dry = render({
    ...base,
    duration: 0.7,
    notes: [{ midi: 60, velocity: 0.9, start: 0, end: 0.18 }],
  });
  const wet = render({
    ...base,
    duration: 0.7,
    reverb: 1,
    notes: [{ midi: 60, velocity: 0.9, start: 0, end: 0.18 }],
  });
  const early = rms(dry.left, 800, 2400);
  const late = rms(dry.left, dry.left.length - 1800);
  assert.ok(early > late * 4);
  assert.ok(rms(wet.left, wet.left.length - 1800) > rms(dry.left, dry.left.length - 1800) * 1.5);
});

test('sweep mode moves the vowel and the waveform', () => {
  const still = render({ ...base, vowelX: 0.18, vowelY: 0.24, sweep: false });
  const moving = render({
    ...base,
    vowelX: 0.18,
    vowelY: 0.24,
    sweep: true,
    sweepRate: 1.4,
  });
  let diff = 0;
  for (let i = 0; i < still.left.length; i += 5) diff += Math.abs(still.left[i] - moving.left[i]);
  assert.ok(diff > 1);
});

test('factory presets render and match the vowel map', () => {
  const files = fs.readdirSync(presetDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 6);
  const ah = VOWELS.find((vowel) => vowel.id === 'ah');
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(presetDir, file), 'utf8'));
    const patch = applyPatch(raw);
    assert.equal(patch.name, raw.name);
    assert.equal(patch.name, raw.name);
    const audio = render({
      ...patch,
      sampleRate: 12000,
      duration: 0.25,
      seed: 1,
      notes: [
        { midi: 60, velocity: 0.8, start: 0, end: 0.22 },
        { midi: 64, velocity: 0.7, start: 0, end: 0.22 },
      ],
    });
    assert.ok(rms(audio.left) > 0.01, file);
    const mono = new Float32Array(audio.left.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (audio.left[i] + audio.right[i]) * 0.5;
    const wav = encodeWav(mono, audio.sampleRate);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
    assert.equal(wav[22], 1);
  }
  const nave = JSON.parse(fs.readFileSync(path.join(presetDir, 'nave.json'), 'utf8'));
  assert.equal(nave.vowelX, ah.x);
  assert.equal(nave.vowelY, ah.y);
  assert.equal(nave.sweep, false);
});
