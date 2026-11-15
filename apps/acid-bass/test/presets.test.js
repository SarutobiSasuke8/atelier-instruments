import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAcidPattern, SCALES } from "../engine.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../presets");

test("factory presets render a finite bassline", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const preset = JSON.parse(readFileSync(join(dir, file), "utf8"));
    assert.equal(preset.patterns.A.steps.length, 16);
    assert.equal(preset.patterns.D.steps.length, 16);
    assert.ok(SCALES[preset.scale], file);
    const rendered = renderAcidPattern(preset, { ...preset.params, sampleRate: 8000, cycles: 1 });
    let energy = 0;
    for (const sample of rendered.samples) {
      assert.ok(Number.isFinite(sample), file);
      energy += sample * sample;
    }
    assert.ok(Math.sqrt(energy / rendered.samples.length) > 0.02, file);
  }
});
