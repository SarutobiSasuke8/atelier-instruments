import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAcidPattern } from "../engine.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../presets");
const CEILING = 0.89; // -1 dBFS is 0.891

test("every factory preset peaks at or below -1 dBFS", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const preset = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const sampleRate of [44100, 48000]) {
      const { samples } = renderAcidPattern(preset, { ...preset.params, sampleRate, cycles: 2 });
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      assert.ok(peak > 0.05, `${file} @ ${sampleRate} is near silent (${peak})`);
      assert.ok(peak <= CEILING, `${file} @ ${sampleRate} peaks at ${peak.toFixed(5)}`);
    }
  }
});

test("maximum drive and accent still stay under the ceiling", () => {
  const preset = JSON.parse(readFileSync(join(dir, "warehouse-floor.json"), "utf8"));
  const params = { ...preset.params, drive: 1, accent: 1, resonance: 1, envMod: 1, sampleRate: 44100, cycles: 1 };
  const { samples } = renderAcidPattern(preset, params);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak <= CEILING, `peak ${peak}`);
});
