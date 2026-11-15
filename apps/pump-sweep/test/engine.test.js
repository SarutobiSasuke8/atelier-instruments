// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  barsToSeconds,
  detectBpm,
  divisionSeconds,
  prepareParams,
  processPumpSweep,
  pumpGainAt,
  renderDemoLoop,
  resonanceToQ,
} from "../engine.js";
import { encodeWav, encodeWavChannels } from "../../../shared/wav-export.js";
import { parseLoosePreset } from "../../../shared/presets.js";

const here = dirname(fileURLToPath(import.meta.url));

function constant(value, length, sampleRate = 44100, channels = 1) {
  const data = [];
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(length);
    channel.fill(value);
    data.push(channel);
  }
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    channels: data,
    getChannelData: (index) => data[index],
  };
}

function tone(freq, seconds, sampleRate = 44100) {
  const length = Math.floor(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.8;
  }
  return {
    sampleRate,
    numberOfChannels: 1,
    length,
    channels: [data],
    getChannelData: () => data,
  };
}

function rmsRange(channel, sampleRate, startSec, endSec) {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(channel.length, Math.floor(endSec * sampleRate));
  let sum = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    sum += channel[i] * channel[i];
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

test("pump gain ducks on the hit and recovers", () => {
  assert.equal(pumpGainAt(0, 1, 1), 0);
  assert.equal(pumpGainAt(0, 0, 1), 1);
  assert.ok(pumpGainAt(0.45, 1, 0.9) > 0.9);
  assert.ok(pumpGainAt(0.2, 1, 1) > pumpGainAt(0.2, 1, 0));
});

test("divisionSeconds follows the musical rate", () => {
  assert.equal(divisionSeconds(120, "1/4"), 0.5);
  assert.equal(divisionSeconds(120, "1/8"), 0.25);
  assert.ok(Math.abs(barsToSeconds(120, 4) - 8) < 1e-9);
  const prepared = prepareParams({ pump: { rate: "nope", depth: 5 }, bpm: 0 });
  assert.equal(prepared.pump.rate, "1/4");
  assert.equal(prepared.pump.depth, 1);
  assert.equal(prepared.bpm, 40);
});

test("resonance maps into a stable Q range", () => {
  assert.ok(Math.abs(resonanceToQ(0) - 0.5) < 1e-9);
  assert.ok(resonanceToQ(1) > 10);
  assert.ok(resonanceToQ(1) < 30);
});

test("bypass copies the input and does not mutate it", () => {
  const input = tone(440, 0.2, 8000);
  const original = input.getChannelData(0)[10];
  const rendered = processPumpSweep(input, {
    pump: { enabled: false },
    filter: { enabled: false },
  });
  assert.equal(rendered.length, input.length);
  assert.equal(rendered.numberOfChannels, 1);
  assert.equal(rendered.getChannelData(0)[10], original);
  assert.equal(input.getChannelData(0)[10], original);
  rendered.getChannelData(0)[10] = 0;
  assert.equal(input.getChannelData(0)[10], original);
});

test("pump lowers the start of each cycle on a constant signal", () => {
  const sr = 1000;
  const input = constant(1, sr, sr);
  const rendered = processPumpSweep(input, {
    bpm: 120,
    pump: { enabled: true, depth: 1, shape: 1, rate: "1/4", offset: 0 },
    filter: { enabled: false },
  });
  const out = rendered.getChannelData(0);
  assert.ok(Math.abs(out[0]) < 0.001);
  assert.ok(out[250] > 0.95);
});

test("low-pass keeps a low tone and attenuates a high tone", () => {
  const low = processPumpSweep(tone(180, 0.4), {
    pump: { enabled: false },
    filter: { enabled: true, type: "lowpass", cutoff: 400, resonance: 0 },
  });
  const high = processPumpSweep(tone(6000, 0.4), {
    pump: { enabled: false },
    filter: { enabled: true, type: "lowpass", cutoff: 400, resonance: 0 },
  });
  const lowRms = rmsRange(low.getChannelData(0), 44100, 0.15, 0.4);
  const highRms = rmsRange(high.getChannelData(0), 44100, 0.15, 0.4);
  assert.ok(lowRms > 0.25, `low rms ${lowRms}`);
  assert.ok(highRms < lowRms * 0.15, `high rms ${highRms} low ${lowRms}`);
});

test("high-pass attenuates a low tone", () => {
  const low = processPumpSweep(tone(80, 0.4), {
    pump: { enabled: false },
    filter: { enabled: true, type: "highpass", cutoff: 2000, resonance: 0 },
  });
  const high = processPumpSweep(tone(5000, 0.4), {
    pump: { enabled: false },
    filter: { enabled: true, type: "highpass", cutoff: 2000, resonance: 0 },
  });
  const lowRms = rmsRange(low.getChannelData(0), 44100, 0.15, 0.4);
  const highRms = rmsRange(high.getChannelData(0), 44100, 0.15, 0.4);
  assert.ok(highRms > 0.25, `high rms ${highRms}`);
  assert.ok(lowRms < highRms * 0.2, `low rms ${lowRms} high ${highRms}`);
});

test("a cut gesture silences the middle of the buffer", () => {
  const input = constant(0.8, 44100, 44100);
  const rendered = processPumpSweep(input, {
    pump: { enabled: false },
    filter: { enabled: false },
    performance: [{ type: "cut", start: 0.3, end: 0.55 }],
  });
  const out = rendered.getChannelData(0);
  const before = rmsRange(out, 44100, 0.02, 0.2);
  const mid = rmsRange(out, 44100, 0.38, 0.5);
  const after = rmsRange(out, 44100, 0.7, 0.9);
  assert.ok(before > 0.7);
  assert.ok(mid < 0.02, `mid ${mid}`);
  assert.ok(after > 0.7);
});

test("a longer sweep opens a low-pass further than a shy one", () => {
  const input = tone(3000, 1);
  const base = {
    pump: { enabled: false },
    filter: { enabled: true, type: "lowpass", cutoff: 18000, resonance: 0.1 },
  };
  const full = processPumpSweep(input, {
    ...base,
    performance: [{ type: "build", start: 0, end: 1, sweepSeconds: 1 }],
  });
  const shy = processPumpSweep(input, {
    ...base,
    performance: [{ type: "build", start: 0, end: 1, sweepSeconds: 8 }],
  });
  const fullRms = rmsRange(full.getChannelData(0), 44100, 0.82, 0.98);
  const shyRms = rmsRange(shy.getChannelData(0), 44100, 0.82, 0.98);
  assert.ok(fullRms > shyRms * 4, `full ${fullRms} shy ${shyRms}`);
});

test("stereo channel count is preserved", () => {
  const input = constant(0.2, 500, 8000, 2);
  input.channels[1].fill(-0.4);
  const rendered = processPumpSweep(input, {
    pump: { enabled: false },
    filter: { enabled: false },
  });
  assert.equal(rendered.numberOfChannels, 2);
  assert.ok(rendered.getChannelData(1)[3] < 0);
});

test("tempo detection finds a click train", () => {
  const sr = 22050;
  const bpm = 120;
  const period = Math.round((sr * 60) / bpm);
  const length = period * 8;
  const data = new Float32Array(length);
  for (let beat = 0; beat < 8; beat++) {
    const at = beat * period;
    data[at] = 1;
    if (at + 1 < length) data[at + 1] = 0.5;
    if (at + 2 < length) data[at + 2] = 0.2;
  }
  const found = detectBpm(
    { sampleRate: sr, numberOfChannels: 1, length, getChannelData: () => data },
    { minBpm: 80, maxBpm: 160 },
  );
  assert.ok(Math.abs(found.bpm - 120) <= 2, `detected ${found.bpm} confidence ${found.confidence}`);
  assert.ok(found.confidence > 0.2);
});

test("desk loop has the expected length and a usable tempo", () => {
  const loop = renderDemoLoop({ bpm: 124, bars: 2, sampleRate: 22050 });
  const expected = Math.floor(8 * (60 / 124) * 22050);
  assert.equal(loop.buffer.length, expected);
  assert.equal(loop.buffer.numberOfChannels, 2);
  assert.equal(loop.bpm, 124);
  const found = detectBpm(loop.buffer, { minBpm: 90, maxBpm: 160 });
  assert.ok(Math.abs(found.bpm - 124) <= 3, `demo detected ${found.bpm}`);
});

test("wav encoder writes a PCM header and clamps peaks", () => {
  const data = Float32Array.from([0, 1, -1]);
  const wav = encodeWav(data, 8000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), "RIFF");
  assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
  const stereo = encodeWavChannels([data, Float32Array.from([-1, 0, 1])], 8000);
  const stereoView = new DataView(stereo.buffer, stereo.byteOffset, stereo.byteLength);
  assert.equal(stereoView.getUint16(22, true), 2);
  assert.equal(stereoView.getInt16(44, true), 0);
  assert.equal(stereoView.getInt16(46, true), -32768);
});

test("factory presets parse", () => {
  const dir = join(here, "..", "presets");
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  assert.ok(index.length >= 4);
  const files = new Set(readdirSync(dir));
  for (const name of index) {
    assert.ok(files.has(name), name);
    const preset = parseLoosePreset(readFileSync(join(dir, name), "utf8"));
    assert.equal(typeof preset.name, "string");
    assert.ok(preset.pump && preset.filter);
    const rendered = processPumpSweep(constant(0.5, 200, 8000), preset);
    assert.equal(rendered.length, 200);
  }
});
