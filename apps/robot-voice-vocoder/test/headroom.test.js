import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDemoVowel, OUTPUT_CEILING, renderVocoded } from "../engine.js";

const CEILING = 0.89; // -1 dBFS is 0.891
const presetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../presets");
const sampleRate = 44100;
const notes = [48, 55, 60, 64, 67].map((note) => ({ note, start: 0, duration: 1.2, velocity: 1 }));

function hotVoice() {
  const out = new Float32Array(sampleRate * 2);
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const x = 1.6 * Math.sin(2 * Math.PI * 140 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) + 0.3 * Math.sin(2 * Math.PI * 2200 * t);
    out[i] = Math.max(-1, Math.min(1, x));
  }
  return out;
}

function peakOf(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

test("output ceiling sits below -1 dBFS", () => {
  assert.ok(OUTPUT_CEILING <= CEILING);
});

test("every preset peaks at or below -1 dBFS with the demo vowel and a full-scale voice", () => {
  const vowel = makeDemoVowel(sampleRate, 1.5);
  const loud = hotVoice();
  for (const file of readdirSync(presetDir).filter((name) => name.endsWith(".json"))) {
    const preset = JSON.parse(readFileSync(path.join(presetDir, file), "utf8"));
    for (const voice of [vowel, loud]) {
      const { samples } = renderVocoded({ samples: voice, sampleRate }, notes, preset, { duration: 1.2, seed: 3 });
      const peak = peakOf(samples);
      assert.ok(peak > 0.05, `${file} is near silent (${peak})`);
      assert.ok(peak <= CEILING, `${file} peaks at ${peak.toFixed(5)}`);
    }
  }
});

test("full gain, hot input and heavy effects still stay under the ceiling", () => {
  const preset = {
    ...JSON.parse(readFileSync(path.join(presetDir, "wide-stack.json"), "utf8")),
    gain: 1, inputGain: 2, reverb: 0.6, delayMix: 0.6, delayFeedback: 0.8, chorus: 0.5,
  };
  const { samples } = renderVocoded({ samples: hotVoice(), sampleRate }, notes, preset, { duration: 1.2, seed: 3 });
  assert.ok(peakOf(samples) <= CEILING);
});
