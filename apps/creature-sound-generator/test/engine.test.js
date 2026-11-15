import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GESTURES,
  MOODS,
  SAMPLE_RATE,
  SPECIES,
  renderCreature,
} from "../engine.js";
import { encodeWav } from "../../../shared/wav-export.js";
import { parsePreset, serializePreset } from "../../../shared/presets.js";
import { zipStore } from "../ui/zip-store.js";

const base = {
  size: 0.48,
  mood: 0.08,
  species: 0,
  roughness: 0.3,
};

function stats(audio) {
  const samples = audio.samples;
  let peak = 0;
  let sum = 0;
  let mean = 0;
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    assert.ok(Number.isFinite(s), "sample is finite");
    const mag = Math.abs(s);
    if (mag > peak) peak = mag;
    sum += s * s;
    mean += s;
    if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) crossings += 1;
    prev = s;
  }
  return {
    peak,
    rms: Math.sqrt(sum / samples.length),
    dc: mean / samples.length,
    zcr: crossings / audio.duration,
  };
}

function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length, 8000);
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i] - b[i]);
  return d / n;
}

function earlyRms(audio, seconds) {
  const n = Math.min(audio.samples.length, Math.floor(seconds * audio.sampleRate));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += audio.samples[i] ** 2;
  return Math.sqrt(sum / Math.max(1, n));
}

function highBand(samples) {
  let low = 0;
  let energy = 0;
  const k = 0.18;
  for (let i = 0; i < samples.length; i++) {
    low += k * (samples[i] - low);
    const high = samples[i] - low;
    energy += high * high;
  }
  return energy / samples.length;
}

test("renderCreature returns deterministic PCM", () => {
  const a = renderCreature({ ...base, gesture: "attack" }, 42);
  const b = renderCreature({ ...base, gesture: "attack" }, 42);
  assert.equal(a.sampleRate, SAMPLE_RATE);
  assert.equal(a.samples.length, b.samples.length);
  assert.equal(a.duration, a.samples.length / SAMPLE_RATE);
  assert.equal(a.gesture, "attack");
  assert.equal(a.speciesName, "beast");
  for (let i = 0; i < a.samples.length; i++) assert.equal(a.samples[i], b.samples[i]);
  const info = stats(a);
  assert.ok(info.peak > 0.2 && info.peak <= 1);
  assert.ok(info.rms > 0.02);
  assert.ok(Math.abs(info.dc) < 0.05);
});

test("seeds, gestures and species change the take", () => {
  const idle = renderCreature({ ...base, gesture: "idle" }, 7);
  const idleOther = renderCreature({ ...base, gesture: "idle" }, 8);
  const attack = renderCreature({ ...base, gesture: "attack" }, 7);
  const bird = renderCreature({ ...base, species: 0.25, gesture: "idle" }, 7);
  assert.ok(meanAbsDiff(idle.samples, idleOther.samples) > 0.01);
  assert.ok(meanAbsDiff(idle.samples, attack.samples) > 0.02);
  assert.ok(meanAbsDiff(idle.samples, bird.samples) > 0.02);
  assert.ok(stats(bird).zcr > stats(renderCreature({ ...base, size: 0.75, gesture: "idle" }, 7)).zcr * 1.6);
});

test("death outlasts attack and attack is front-loaded", () => {
  const attack = renderCreature({ ...base, gesture: "attack" }, 3);
  const death = renderCreature({ ...base, gesture: "death" }, 3);
  const idle = renderCreature({ ...base, gesture: "idle" }, 3);
  assert.ok(death.duration > attack.duration * 1.6);
  assert.ok(earlyRms(attack, 0.04) > earlyRms(idle, 0.04));
});

test("every gesture, species and mood renders a bounded take", () => {
  for (const gesture of GESTURES) {
    for (const species of [0, 0.25, 0.5, 0.75, 1]) {
      const audio = renderCreature({
        size: 0.2 + species * 0.6,
        mood: species,
        species,
        roughness: species * 0.8,
        gesture,
      }, 11 + species * 10);
      const info = stats(audio);
      assert.ok(audio.duration >= 0.12 && audio.duration <= 3.5);
      assert.ok(info.peak > 0.05 && info.peak <= 1);
      assert.ok(SPECIES.includes(audio.speciesName));
      assert.ok(MOODS.includes(audio.moodName));
    }
  }
});

test("roughness adds grit and bad inputs are clamped", () => {
  const smooth = renderCreature({ ...base, roughness: 0, gesture: "talk" }, 19);
  const rough = renderCreature({ ...base, roughness: 1, gesture: "talk" }, 19);
  assert.ok(highBand(rough.samples) > highBand(smooth.samples));
  const clamped = renderCreature({
    size: 9,
    mood: -4,
    species: 80,
    roughness: Number.NaN,
    gesture: "screech",
    velocity: 2,
  }, Number.NaN);
  assert.equal(clamped.params.size, 1);
  assert.equal(clamped.params.mood, 0);
  assert.equal(clamped.params.species, 1);
  assert.equal(clamped.params.roughness, 0.25);
  assert.equal(clamped.gesture, "idle");
  assert.equal(clamped.seed, 1);
  assert.ok(stats(clamped).peak > 0.05);
});

test("ten seeds are ten different variations", () => {
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const audio = renderCreature({ ...base, species: 0.5, gesture: "talk" }, 1000 + i * 997);
    let hash = 2166136261;
    for (let s = 0; s < audio.samples.length; s += 19) {
      hash ^= Math.floor((audio.samples[s] + 1) * 1000);
      hash = Math.imul(hash, 16777619);
    }
    seen.add(hash >>> 0);
  }
  assert.equal(seen.size, 10);
});

test("wav encoder writes a matching PCM file", () => {
  const audio = renderCreature({ ...base, gesture: "hurt" }, 5);
  const wav = encodeWav(audio.samples, audio.sampleRate);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString("ascii"), "WAVE");
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint32(40, true), audio.samples.length * 2);
  assert.equal(wav.length, 44 + audio.samples.length * 2);
  const decoded = view.getInt16(44, true) / 32768;
  assert.ok(Math.abs(decoded - Math.max(-1, Math.min(1, audio.samples[0]))) < 1 / 32767 + 1e-4);
});

test("factory presets parse and render", () => {
  const url = new URL("../presets/factory.json", import.meta.url);
  const factory = JSON.parse(readFileSync(url));
  assert.ok(factory.length >= 6);
  for (const preset of factory) {
    const parsed = parsePreset(JSON.stringify(preset));
    const again = parsePreset(serializePreset(parsed));
    assert.equal(again.name, parsed.name);
    assert.equal(again.size, parsed.size);
    const audio = renderCreature({ ...parsed, gesture: "idle" }, 2);
    assert.ok(stats(audio).rms > 0.01);
  }
});

test("batch zip stores wav bytes without compression", () => {
  const audio = renderCreature({ ...base, gesture: "idle" }, 1);
  const wav = encodeWav(audio.samples.subarray(0, 64), SAMPLE_RATE);
  const zip = zipStore([{ name: "creature_idle_01.wav", data: wav }]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const text = Buffer.from(zip).toString("latin1");
  assert.ok(text.includes("creature_idle_01.wav"));
  assert.ok(text.includes("RIFF"));
});
