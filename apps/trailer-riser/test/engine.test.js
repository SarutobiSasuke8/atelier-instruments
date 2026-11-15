import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  render,
  normalizeParams,
  gestureSeconds,
  variationParams,
  KINDS,
} from '../engine.js';
import { encodeWav, encodeWavChannels } from '../../../shared/wav-export.js';
import { midiToHz, noteName } from '../../../shared/midi.js';

const here = dirname(fileURLToPath(import.meta.url));
const presetDir = join(here, '../presets');

function rms(buffer, start, end) {
  let sum = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / n);
}

function peakAt(buffer, length) {
  let max = 0;
  let index = 0;
  for (let i = 0; i < length; i += 1) {
    const value = Math.abs(buffer[i]);
    if (value > max) {
      max = value;
      index = i;
    }
  }
  return { max, index };
}

function assertFiniteAudio(audio) {
  assert.equal(audio.channels, 2);
  assert.equal(audio.left.length, audio.frames);
  assert.equal(audio.right.length, audio.frames);
  assert.ok(audio.frames > 8);
  for (let i = 0; i < audio.frames; i += 16) {
    assert.ok(Number.isFinite(audio.left[i]), `left ${i}`);
    assert.ok(Number.isFinite(audio.right[i]), `right ${i}`);
  }
  assert.ok(audio.peak > 0.02, `peak ${audio.peak}`);
  assert.ok(audio.peak <= 1, `peak ${audio.peak}`);
}

const short = { seconds: 0.45, lengthMode: 'seconds', size: 0.45, intensity: 0.7, pitch: 36, darkness: 0.4, seed: 3 };

test('every kind renders finite stereo audio', () => {
  for (const kind of KINDS) {
    const audio = render({ ...short, kind: kind.id }, { sampleRate: 16000 });
    assertFiniteAudio(audio);
  }
});

test('render is deterministic for a seed', () => {
  const a = render({ ...short, kind: 'riser' }, { sampleRate: 12000 });
  const b = render({ ...short, kind: 'riser' }, { sampleRate: 12000 });
  let diff = 0;
  for (let i = 0; i < a.frames; i += 1) diff += Math.abs(a.left[i] - b.left[i]);
  assert.equal(diff, 0);
});

test('a different seed changes the riser', () => {
  const a = render({ ...short, kind: 'riser', seed: 1 }, { sampleRate: 12000 });
  const b = render({ ...short, kind: 'riser', seed: 9 }, { sampleRate: 12000 });
  let diff = 0;
  for (let i = 0; i < a.frames; i += 1) diff += Math.abs(a.left[i] - b.left[i]);
  assert.ok(diff > 0.5, diff);
});

test('riser energy grows toward the cut', () => {
  const audio = render({ ...short, kind: 'riser', seconds: 0.8, size: 0.2 }, { sampleRate: 16000 });
  const quarter = Math.floor(audio.gestureFrames / 4);
  const early = rms(audio.left, 0, quarter);
  const late = rms(audio.left, audio.gestureFrames - quarter, audio.gestureFrames);
  assert.ok(late > early * 1.4, `late ${late} early ${early}`);
});

test('reverse swell is louder at the landing than at the start', () => {
  const audio = render({ ...short, kind: 'reverse', seconds: 0.8, size: 0.2 }, { sampleRate: 16000 });
  const quarter = Math.floor(audio.gestureFrames / 4);
  const early = rms(audio.left, 0, quarter);
  const late = rms(audio.left, audio.gestureFrames - quarter, audio.gestureFrames);
  assert.ok(late > early * 1.3, `late ${late} early ${early}`);
});

test('impact peak sits in the attack', () => {
  const audio = render({ ...short, kind: 'impact', seconds: 0.7, size: 0.4 }, { sampleRate: 16000 });
  const { index } = peakAt(audio.left, audio.gestureFrames);
  assert.ok(index / audio.gestureFrames < 0.15, index / audio.gestureFrames);
});

test('whoosh peak sits in the body of the pass', () => {
  const audio = render({ ...short, kind: 'whoosh', seconds: 0.7, pitch: 52, darkness: 0.3 }, { sampleRate: 16000 });
  const { index } = peakAt(audio.left, audio.gestureFrames);
  const pos = index / audio.gestureFrames;
  assert.ok(pos > 0.15 && pos < 0.88, pos);
});

test('size opens a stereo image', () => {
  const audio = render({ ...short, kind: 'brass', size: 0.95 }, { sampleRate: 16000 });
  let diff = 0;
  for (let i = 0; i < audio.frames; i += 1) diff += Math.abs(audio.left[i] - audio.right[i]);
  assert.ok(diff > 0.2, diff);
});

test('bars follow tempo', () => {
  const params = normalizeParams({ lengthMode: 'bars', bars: 2, tempo: 120, kind: 'impact' });
  assert.equal(gestureSeconds(params), 4);
  const audio = render({ ...params, size: 0.1, seconds: 0.2 }, { sampleRate: 8000 });
  assert.ok(Math.abs(audio.gestureDuration - 4) < 0.002);
});

test('normalize clamps nonsense and unknown kinds fall back', () => {
  const params = normalizeParams({ kind: 'nope', intensity: 8, pitch: -4, seconds: 0 });
  assert.equal(params.kind, 'riser');
  assert.equal(params.intensity, 1);
  assert.equal(params.pitch, 16);
  assert.equal(params.seconds, 0.2);
});

test('variations stay in range and differ', () => {
  const base = normalizeParams({ kind: 'whoosh', seed: 4, pitch: 50, seconds: 1 });
  const a = variationParams(base, 0);
  const b = variationParams(base, 1);
  assert.notEqual(a.seed, b.seed);
  assert.ok(Math.abs(a.pitch - b.pitch) > 0.001 || a.darkness !== b.darkness);
  for (const params of [a, b]) {
    assert.ok(params.pitch >= 16 && params.pitch <= 84);
    assert.ok(params.intensity >= 0 && params.intensity <= 1);
  }
});

test('wav header matches the buffer', () => {
  const audio = render({ ...short, kind: 'impact' }, { sampleRate: 16000 });
  const wav = encodeWavChannels([audio.left, audio.right], audio.sampleRate);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), audio.frames * 4);
  assert.equal(wav.length, 44 + audio.frames * 4);
  const mono = encodeWav(audio.left, audio.sampleRate);
  assert.equal(new DataView(mono.buffer).getUint16(22, true), 1);
});

test('midi note names', () => {
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(36), 'C2');
});

test('factory presets render', () => {
  const files = readdirSync(presetDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(presetDir, file), 'utf8'));
    const params = normalizeParams({ ...data, lengthMode: 'seconds', seconds: 0.25 });
    assert.equal(params.kind, data.kind);
    const audio = render(params, { sampleRate: 12000 });
    assert.ok(audio.peak > 0.02, file);
  }
});
