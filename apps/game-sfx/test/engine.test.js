import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  PACKS,
  SAMPLE_RATE,
  clampParams,
  defaultParams,
  mutateLocked,
  renderSfx,
  suggestedFileName,
  varyAround,
} from "../engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function rms(samples) {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return Math.sqrt(energy / samples.length);
}

function zcr(samples, start = 0, end = samples.length) {
  let crosses = 0;
  const i0 = Math.max(1, start);
  const i1 = Math.min(samples.length, end);
  for (let i = i0; i < i1; i += 1) {
    if (samples[i - 1] >= 0 !== samples[i] >= 0) crosses += 1;
  }
  return crosses / Math.max(1, i1 - i0);
}

function hfEnergy(samples) {
  let energy = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const d = samples[i] - samples[i - 1];
    energy += d * d;
  }
  return energy / samples.length;
}

function earlyRatio(samples, seconds) {
  const n = Math.max(2, Math.round(seconds * SAMPLE_RATE));
  let early = 0;
  let all = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const e = samples[i] * samples[i];
    all += e;
    if (i < n) early += e;
  }
  return early / Math.max(1e-12, all);
}

test("every category renders a finite, audible buffer", () => {
  for (const category of CATEGORIES) {
    const sound = renderSfx(category.id, {}, 7);
    assert.equal(sound.category, category.id);
    assert.equal(sound.sampleRate, SAMPLE_RATE);
    assert.ok(sound.samples instanceof Float32Array);
    assert.ok(sound.duration > 0.01 && sound.duration < 1.4);
    assert.ok(rms(sound.samples) > 0.02, category.id);
    for (let i = 0; i < sound.samples.length; i += 1) {
      const s = sound.samples[i];
      assert.ok(Number.isFinite(s), category.id);
      assert.ok(s <= 1 && s >= -1, category.id);
    }
  }
});

test("renderSfx is deterministic and seed-sensitive", () => {
  const params = defaultParams();
  const a = renderSfx("coin", params, 42);
  const b = renderSfx("coin", params, 42);
  const c = renderSfx("coin", params, 43);
  assert.deepEqual(a.samples, b.samples);
  assert.notDeepEqual(Array.from(a.samples), Array.from(c.samples));
  const quietA = renderSfx("jump", { ...params, noise: 0 }, 3);
  const quietB = renderSfx("jump", { ...params, noise: 0 }, 99);
  assert.notDeepEqual(Array.from(quietA.samples.slice(0, 400)), Array.from(quietB.samples.slice(0, 400)));
});

test("unknown category throws", () => {
  assert.throws(() => renderSfx("powerup", {}, 1), /Unknown category/);
  assert.throws(() => renderSfx("", {}, 1), /Unknown category/);
});

test("length changes duration for every voice", () => {
  for (const category of CATEGORIES) {
    const short = renderSfx(category.id, { length: 0.05 }, 5);
    const long = renderSfx(category.id, { length: 0.95 }, 5);
    assert.ok(long.samples.length > short.samples.length, category.id);
  }
});

test("pitch, sweep, noise, punch, and era move the buffer", () => {
  const base = { ...defaultParams(), noise: 0, style: 1, sweep: 0.5, punch: 0.2 };
  const low = renderSfx("jump", { ...base, pitch: 0.05 }, 8);
  const high = renderSfx("jump", { ...base, pitch: 0.95 }, 8);
  assert.ok(zcr(high.samples) > zcr(low.samples) * 1.25);

  const down = renderSfx("laser", { ...base, sweep: 0.05, length: 0.8 }, 4);
  const up = renderSfx("laser", { ...base, sweep: 0.95, length: 0.8 }, 4);
  const midStart = Math.floor(down.samples.length * 0.35);
  const midEnd = Math.floor(down.samples.length * 0.55);
  assert.ok(zcr(up.samples, midStart, midEnd) > zcr(down.samples, midStart, midEnd));

  const dry = renderSfx("explosion", { ...defaultParams(), noise: 0, style: 0.8 }, 6);
  const wet = renderSfx("explosion", { ...defaultParams(), noise: 1, style: 0.8 }, 6);
  assert.ok(hfEnergy(wet.samples) > hfEnergy(dry.samples));

  const soft = renderSfx("hit", { ...defaultParams(), punch: 0, noise: 0.2 }, 9);
  const hard = renderSfx("hit", { ...defaultParams(), punch: 1, noise: 0.2 }, 9);
  assert.ok(earlyRatio(hard.samples, 0.012) > earlyRatio(soft.samples, 0.012));

  const retro = renderSfx("jump", { ...base, style: 0, pitch: 0.5 }, 8);
  const modern = renderSfx("jump", { ...base, style: 1, pitch: 0.5 }, 8);
  assert.ok(hfEnergy(retro.samples) > hfEnergy(modern.samples));
});

test("params clamp and vary stay inside 0..1", () => {
  const clamped = clampParams({ pitch: 4, length: -2, sweep: "nope", extra: 1 });
  assert.equal(clamped.pitch, 1);
  assert.equal(clamped.length, 0);
  assert.equal(clamped.sweep, 0);
  assert.equal(clamped.extra, undefined);
  assert.equal(clamped.style, defaultParams().style);

  const varied = varyAround({ pitch: 0.5, length: 0.5 }, 12, 0);
  assert.equal(varied.pitch, 0.5);
  assert.equal(varied.length, 0.5);

  const mutated = mutateLocked({ category: "Menu Click", params: defaultParams(), seed: 10 }, 2);
  assert.equal(mutated.category, "menu-click");
  assert.notEqual(mutated.seed, 10);
  for (const value of Object.values(mutated.params)) {
    assert.ok(value >= 0 && value <= 1);
  }
  const again = mutateLocked({ category: "menu-click", params: defaultParams(), seed: 10 }, 2);
  assert.deepEqual(mutated, again);
});

test("pack names cover the bench with stable file names", () => {
  const seen = new Set();
  for (const pack of Object.values(PACKS)) {
    assert.match(pack.filename, /^[a-z]+-pack\.zip$/);
    for (const category of pack.categories) {
      const name = suggestedFileName(category, 1, pack.id);
      assert.match(name, /^[a-z]+-[a-z-]+\.wav$/);
      assert.equal(seen.has(name), false);
      seen.add(name);
      assert.equal(renderSfx(category, {}, 1).suggestedName.startsWith(category), true);
    }
  }
  assert.equal(seen.size, 12);
});

test("factory presets all render", () => {
  const bank = JSON.parse(readFileSync(path.join(here, "../presets/factory.json"), "utf8"));
  assert.ok(bank.items.length >= CATEGORIES.length);
  const covered = new Set();
  for (const item of bank.items) {
    const sound = renderSfx(item.category, item.params, item.seed);
    assert.equal(sound.category, item.category);
    assert.ok(rms(sound.samples) > 0.02);
    covered.add(sound.category);
  }
  assert.equal(covered.size, CATEGORIES.length);
});
