import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderArp } from "../engine.js";
import { OUTPUT_CEILING, renderVoices } from "../synth-offline.js";

const CEILING = 0.89; // -1 dBFS is 0.891
const factory = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../presets/factory.json"), "utf8"));

function chordsOf(preset) {
  const slots = (preset.slots || []).filter((slot) => slot.length);
  return preset.walk
    ? slots.map((notes, index) => ({ notes, start: index * 4, length: 4 }))
    : [{ notes: preset.sounding, start: 0, length: 4 }];
}

function peakOf(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

test("output ceiling sits below -1 dBFS", () => {
  assert.ok(OUTPUT_CEILING <= CEILING);
});

test("every factory preset peaks at or below -1 dBFS", () => {
  for (const preset of factory) {
    const { events } = renderArp(chordsOf(preset), { ...preset.arp, bpm: preset.bpm });
    for (const sampleRate of [44100, 48000]) {
      const peak = peakOf(renderVoices(events, { ...preset.synth, bpm: preset.bpm, sampleRate }));
      assert.ok(peak > 0.05, `${preset.name} @ ${sampleRate} is near silent (${peak})`);
      assert.ok(peak <= CEILING, `${preset.name} @ ${sampleRate} peaks at ${peak.toFixed(5)}`);
    }
  }
});

test("full gain, resonance and a stacked chord still stay under the ceiling", () => {
  const preset = factory[0];
  const arp = { ...preset.arp, mode: "chord", octaves: 4, velocity: 127, accentVelocity: 127 };
  const { events } = renderArp(chordsOf(preset), { ...arp, bpm: preset.bpm });
  const synth = { ...preset.synth, gain: 1, resonance: 0.92, cutoff: 14000, sustain: 1, attack: 0.001, decay: 0.001 };
  const peak = peakOf(renderVoices(events, { ...synth, bpm: preset.bpm, sampleRate: 44100 }));
  assert.ok(peak <= CEILING, `peak ${peak}`);
});
