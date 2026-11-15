import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bandPlan,
  makeDemoVowel,
  mergePreset,
  renderVocoded,
  snapBands,
} from "../engine.js";

const presetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../presets");

function rms(samples) {
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
  return Math.sqrt(acc / samples.length);
}

function absDiff(a, b) {
  let diff = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) diff += Math.abs(a[i] - b[i]);
  return diff;
}

function assertFinite(samples) {
  for (let i = 0; i < samples.length; i++) {
    assert.equal(Number.isFinite(samples[i]), true, `sample ${i} is ${samples[i]}`);
  }
}

const DRY = {
  mode: "robot",
  dryWet: 1,
  gain: 1,
  inputGain: 1,
  sibilance: 0,
  noiseBlend: 0,
  chorus: 0,
  delayMix: 0,
  reverb: 0,
  wave: "saw",
  unison: 1,
  detune: 0,
  arp: { enabled: false },
  monotone: false,
};

test("band centers follow formant shift until nyquist", () => {
  const low = bandPlan(8, 44100, 0, 4);
  const up = bandPlan(8, 44100, 12, 4);
  assert.equal(low.length, 8);
  assert.ok(Math.abs(up[0].car / low[0].car - 2) < 0.02);
  assert.ok(up[up.length - 1].car <= 44100 * 0.45 + 1);
  assert.equal(snapBands(20), 16);
  assert.equal(snapBands(30), 32);
  assert.equal(mergePreset({ formant: 99, bands: 12, mode: "nope" }).formant, 12);
  assert.equal(mergePreset({ formant: 99, bands: 12, mode: "nope" }).bands, 8);
  assert.equal(mergePreset({ formant: 99, bands: 12, mode: "nope" }).mode, "robot");
});

test("dry bypass copies the voice", () => {
  const voice = new Float32Array(2400);
  for (let i = 0; i < voice.length; i++) voice[i] = Math.sin(i * 0.037) * 0.4;
  const out = renderVocoded(
    { samples: voice, sampleRate: 24000 },
    [],
    { dryWet: 0, gain: 1, inputGain: 1, chorus: 0, delayMix: 0, reverb: 0 },
    { sampleRate: 24000, duration: voice.length / 24000 },
  );
  assert.equal(out.samples.length, voice.length);
  assert.ok(absDiff(out.samples, voice) < 1e-6);
});

test("a sung carrier is louder than a silent modulator", () => {
  const voice = makeDemoVowel(22050, 0.3);
  const opts = { sampleRate: 22050, duration: 0.3, seed: 3 };
  const quiet = renderVocoded({ samples: new Float32Array(voice.length), sampleRate: 22050 }, [
    { note: 60, start: 0, duration: 0.3, velocity: 0.9 },
  ], DRY, opts);
  const sung = renderVocoded({ samples: voice, sampleRate: 22050 }, [
    { note: 60, start: 0, duration: 0.3, velocity: 0.9 },
  ], DRY, opts);
  const quietRms = rms(quiet.samples);
  const sungRms = rms(sung.samples);
  assert.ok(quietRms < 0.003, `quiet rms ${quietRms}`);
  assert.ok(sungRms > 0.02, `sung rms ${sungRms}`);
  assertFinite(sung.samples);
  assert.ok(sung.peak <= 1);
});

test("pitch, band count, and the arpeggiator change the bounce", () => {
  const voice = makeDemoVowel(16000, 0.35);
  const buffer = { samples: voice, sampleRate: 16000 };
  const opts = { sampleRate: 16000, duration: 0.35, seed: 9 };
  const low = renderVocoded(buffer, [{ note: 48, start: 0, duration: 0.35, velocity: 0.9 }], DRY, opts);
  const high = renderVocoded(buffer, [{ note: 72, start: 0, duration: 0.35, velocity: 0.9 }], DRY, opts);
  assert.ok(absDiff(low.samples, high.samples) > 1);
  const wide = renderVocoded(buffer, [{ note: 60, start: 0, duration: 0.35 }], { ...DRY, bands: 32 }, opts);
  const narrow = renderVocoded(buffer, [{ note: 60, start: 0, duration: 0.35 }], { ...DRY, bands: 8 }, opts);
  assert.equal(wide.bands, 32);
  assert.equal(narrow.bands, 8);
  assert.ok(absDiff(wide.samples, narrow.samples) > 1);
  const chord = [
    { note: 48, start: 0, duration: 0.35, velocity: 0.8 },
    { note: 55, start: 0, duration: 0.35, velocity: 0.8 },
    { note: 62, start: 0, duration: 0.35, velocity: 0.8 },
  ];
  const stacked = renderVocoded(buffer, chord, DRY, opts);
  const arped = renderVocoded(buffer, chord, { ...DRY, arp: { enabled: true, rate: 8, pattern: "up", octaves: 2, gate: 0.5 } }, opts);
  assert.ok(absDiff(stacked.samples, arped.samples) > 1);
});

test("monotone locks the carrier to the root", () => {
  const voice = makeDemoVowel(16000, 0.25);
  const buffer = { samples: voice, sampleRate: 16000 };
  const preset = { ...DRY, mode: "monotone", monotone: true, root: 45, wave: "saw", unison: 1, detune: 0 };
  const opts = { sampleRate: 16000, duration: 0.25, seed: 1 };
  const a = renderVocoded(buffer, [{ note: 60, start: 0, duration: 0.25, velocity: 0.8 }], preset, opts);
  const b = renderVocoded(buffer, [{ note: 76, start: 0, duration: 0.25, velocity: 0.8 }], preset, opts);
  assert.equal(absDiff(a.samples, b.samples), 0);
  const free = renderVocoded(buffer, [{ note: 76, start: 0, duration: 0.25, velocity: 0.8 }], { ...DRY, mode: "robot" }, opts);
  assert.ok(absDiff(a.samples, free.samples) > 1);
});

test("whisper breathes without a keyboard and renders are deterministic", () => {
  const voice = makeDemoVowel(16000, 0.3);
  const buffer = { samples: voice, sampleRate: 16000 };
  const preset = mergePreset({ mode: "whisper" });
  const opts = { sampleRate: 16000, duration: 0.3, seed: 11, loop: true };
  const a = renderVocoded(buffer, [], preset, opts);
  const b = renderVocoded(buffer, [], preset, opts);
  assert.ok(rms(a.samples) > 0.01, `whisper rms ${rms(a.samples)}`);
  assert.equal(absDiff(a.samples, b.samples), 0);
  assertFinite(a.samples);
});

test("every shipped preset bounces finite audio for all band counts", () => {
  const files = readdirSync(presetDir).filter((name) => name.endsWith(".json")).sort();
  assert.equal(files.length, 6);
  const voice = makeDemoVowel(16000, 0.2);
  const notes = [
    { note: 48, start: 0, duration: 0.2, velocity: 0.8 },
    { note: 55, start: 0, duration: 0.2, velocity: 0.75 },
    { note: 64, start: 0.08, duration: 0.12, velocity: 0.7 },
  ];
  const modes = new Set();
  for (const file of files) {
    const preset = JSON.parse(readFileSync(path.join(presetDir, file), "utf8"));
    assert.equal(typeof preset.name, "string");
    modes.add(preset.mode);
    for (const bands of [8, 16, 24, 32]) {
      const out = renderVocoded(
        { samples: voice, sampleRate: 16000 },
        notes,
        { ...preset, bands },
        { sampleRate: 16000, duration: 0.16, seed: 4 },
      );
      assert.equal(out.bands, bands);
      assertFinite(out.samples);
      assert.ok(out.peak <= 1);
    }
  }
  for (const mode of ["robot", "choir", "talkbox", "whisper", "monotone"]) {
    assert.ok(modes.has(mode), `missing preset for ${mode}`);
  }
});
