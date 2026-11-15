import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeWav, encodeWavChannels } from "../../../shared/wav-export.js";
import {
  RANGES,
  createTapeMachine,
  defaultPreset,
  makeDemoReel,
  printGestures,
  randomizePreset,
  render,
  resample,
  sanitizePreset,
} from "../engine.js";

function ramp(length) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = (i / Math.max(1, length - 1)) * 2 - 1;
  return data;
}

function sine(sampleRate, freq, frames) {
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.8;
  }
  return data;
}

function energy(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return sum / Math.max(1, data.length);
}

function nearly(a, b, eps = 1e-5) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < eps, `sample ${i}: ${a[i]} vs ${b[i]}`);
  }
}

function exactPreset(extra = {}) {
  return { ...defaultPreset(), slewMs: 0, edgeMs: 0, gain: 1, ...extra };
}

test("dry render matches the reel", () => {
  const input = Float32Array.from([0, 0.25, -0.5, 0.75, -1, 1, 0.1, -0.1]);
  const out = render({
    channels: [input],
    sampleRate: 8000,
    preset: exactPreset(),
    gestures: [],
  });
  nearly(out.channels[0], input);
});

test("machine block path matches render", () => {
  const input = ramp(32);
  const preset = exactPreset();
  const offline = render({ channels: [input], sampleRate: 1000, preset, gestures: [] });
  const machine = createTapeMachine({
    channels: [input],
    sampleRate: 1000,
    preset,
    rolling: true,
  });
  const live = [new Float32Array(input.length)];
  machine.renderBlock(live, input.length);
  nearly(live[0], offline.channels[0]);
});

test("loop repeats and a stopped reel falls silent", () => {
  const input = Float32Array.from([0.1, -0.2, 0.3, -0.4]);
  const looped = render({
    channels: [input],
    sampleRate: 4,
    duration: 2,
    preset: exactPreset(),
    loop: true,
  });
  assert.equal(looped.length, 8);
  nearly(looped.channels[0], Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.1, -0.2, 0.3, -0.4]));
  const once = render({
    channels: [input],
    sampleRate: 4,
    duration: 2,
    preset: exactPreset(),
    loop: false,
  });
  nearly(once.channels[0].subarray(4), Float32Array.from([0, 0, 0, 0]));
});

test("reverse plays the reel backwards", () => {
  const input = ramp(16);
  const out = render({
    channels: [input],
    sampleRate: 160,
    preset: exactPreset(),
    startPosition: input.length - 1,
    gestures: [{ type: "reverse", t0: 0, t1: 1 }],
  });
  const expected = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) expected[i] = input[input.length - 1 - i];
  nearly(out.channels[0], expected);
});

test("stutter repeats the captured slice", () => {
  const input = ramp(80);
  const sampleRate = 1000;
  const slice = 20;
  const out = render({
    channels: [input],
    sampleRate,
    duration: 0.04,
    preset: exactPreset({ stutterMs: slice }),
    gestures: [{ type: "stutter", t0: 0, t1: 1 }],
  });
  assert.equal(out.length, 40);
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out.channels[0][i] - input[i % slice]) < 1e-5, `frame ${i}`);
  }
});

test("bitcrush collapses a ramp to a handful of levels", () => {
  const input = ramp(128);
  const out = render({
    channels: [input],
    sampleRate: 8000,
    preset: exactPreset({ crushBits: 2, crushHold: 1 }),
    gestures: [{ type: "crush", t0: 0, t1: 1 }],
  });
  const levels = new Set(Array.from(out.channels[0]).map((value) => Math.round(value * 1000)));
  assert.ok(levels.size <= 5, `expected <= 5 levels, got ${levels.size}`);
  assert.ok(levels.size >= 3);
});

test("dropouts punch holes without wiping the whole reel", () => {
  const input = sine(8000, 220, 8000);
  const out = render({
    channels: [input],
    sampleRate: 8000,
    preset: exactPreset({ dropoutRate: 80, dropoutMs: 40, dropoutDepth: 1, seed: 3 }),
    seed: 3,
    gestures: [{ type: "dropout", t0: 0, t1: 1 }],
  });
  let zeros = 0;
  let loud = 0;
  for (let i = 0; i < out.length; i++) {
    if (out.channels[0][i] === 0) zeros += 1;
    if (Math.abs(out.channels[0][i]) > 0.2) loud += 1;
  }
  assert.ok(zeros > out.length * 0.2, `zeros ${zeros}`);
  assert.ok(loud > out.length * 0.05, `loud ${loud}`);
});

test("tape stop spends its energy in the dive", () => {
  const input = sine(8000, 180, 8000);
  const out = render({
    channels: [input],
    sampleRate: 8000,
    preset: exactPreset({ stopTime: 0.3 }),
    gestures: [{ type: "stop", t0: 0, t1: 1 }],
  });
  const head = energy(out.channels[0].subarray(0, 2000));
  const tail = energy(out.channels[0].subarray(6000));
  assert.ok(head > 0.02, `head energy ${head}`);
  assert.ok(tail < head * 0.02, `tail energy ${tail}`);
});

test("tape start comes up out of silence", () => {
  const sampleRate = 8000;
  const input = sine(sampleRate, 180, sampleRate);
  const out = render({
    channels: [input],
    sampleRate,
    preset: exactPreset({ startTime: 0.55 }),
    gestures: [{ type: "start", t0: 0, t1: 1 }],
  });
  const data = out.channels[0];
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(data[i]) < 1e-4);
  function gap(start, end) {
    const marks = [];
    for (let i = start + 1; i < end; i++) {
      if (data[i - 1] <= 0 && data[i] > 0) marks.push(i);
    }
    if (marks.length < 2) return Infinity;
    let sum = 0;
    for (let i = 1; i < marks.length; i++) sum += marks[i] - marks[i - 1];
    return sum / (marks.length - 1);
  }
  const early = gap(400, 2800);
  const late = gap(6000, 8000);
  assert.ok(late < 80, `late gap ${late}`);
  assert.ok(early > late * 1.8, `early ${early} late ${late}`);
});

test("wow moves the pitch of a sine", () => {
  const sampleRate = 4000;
  const frames = sampleRate * 2;
  const input = sine(sampleRate, 200, frames);
  const dry = render({ channels: [input], sampleRate, preset: exactPreset() });
  const wet = render({
    channels: [input],
    sampleRate,
    preset: exactPreset({ wowDepth: 0.08, wowRate: 1.4 }),
    gestures: [{ type: "wow", t0: 0, t1: 2 }],
  });
  function intervals(data) {
    const marks = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1] <= 0 && data[i] > 0) marks.push(i);
    }
    const gaps = [];
    for (let i = 1; i < marks.length; i++) gaps.push(marks[i] - marks[i - 1]);
    const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
    const variance = gaps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gaps.length;
    return Math.sqrt(variance);
  }
  const drySpread = intervals(dry.channels[0]);
  const wetSpread = intervals(wet.channels[0]);
  assert.ok(wetSpread > drySpread + 0.4, `dry ${drySpread} wet ${wetSpread}`);
});

test("scratch holds the requested head position", () => {
  const input = ramp(101);
  const out = render({
    channels: [input],
    sampleRate: 1000,
    duration: 0.02,
    preset: exactPreset(),
    gestures: [
      {
        type: "scratch",
        t0: 0,
        t1: 1,
        curve: [
          { t: 0, pos: 0.5 },
          { t: 1, pos: 0.5 },
        ],
      },
    ],
  });
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out.channels[0][i] - input[50]) < 1e-5);
  }
});

test("stereo channels stay independent", () => {
  const left = ramp(24);
  const right = new Float32Array(24).fill(-0.35);
  const out = render({
    channels: [left, right],
    sampleRate: 800,
    preset: exactPreset(),
  });
  nearly(out.channels[0], left);
  nearly(out.channels[1], right);
});

test("render is deterministic", () => {
  const input = sine(2000, 90, 2000);
  const gestures = printGestures(1);
  const preset = exactPreset({ seed: 9, dropoutRate: 12, flutterDepth: 0.02, wowDepth: 0.04 });
  const a = render({ channels: [input], sampleRate: 2000, preset, gestures, seed: 9 });
  const b = render({ channels: [input], sampleRate: 2000, preset, gestures, seed: 9 });
  nearly(a.channels[0], b.channels[0]);
  assert.ok(a.channels[0].some((value) => Number.isFinite(value)));
});

test("demo reel is a finite stereo loop", () => {
  const reel = makeDemoReel(8000);
  assert.equal(reel.channels.length, 2);
  assert.equal(reel.channels[0].length, reel.channels[1].length);
  assert.ok(reel.channels[0].length > 1000);
  let peak = 0;
  for (const value of reel.channels[0]) {
    assert.ok(Number.isFinite(value));
    peak = Math.max(peak, Math.abs(value));
  }
  assert.ok(peak > 0.2 && peak <= 0.81);
});

test("sanitize and randomise stay on the panel ranges", () => {
  const wild = sanitizePreset({ wowDepth: 9, crushBits: 1.2, name: "  too long ".repeat(10) });
  assert.equal(wild.wowDepth, RANGES.wowDepth[1]);
  assert.equal(wild.crushBits, RANGES.crushBits[0]);
  assert.ok(wild.name.length <= 48);
  for (let i = 0; i < 20; i++) {
    const preset = randomizePreset(defaultPreset(), () => ((i * 17 + 3) % 100) / 100);
    for (const [key, [min, max]] of Object.entries(RANGES)) {
      assert.ok(preset[key] >= min && preset[key] <= max, key);
    }
  }
});

test("factory presets load and print without blowing up", () => {
  const factory = JSON.parse(readFileSync(new URL("../presets/factory.json", import.meta.url), "utf8"));
  assert.ok(factory.length >= 6);
  const reel = makeDemoReel(4000);
  for (const preset of factory) {
    const clean = sanitizePreset(preset);
    assert.ok(clean.name);
    const printed = render({
      channels: [reel.channels[0].subarray(0, 1200)],
      sampleRate: 4000,
      duration: 0.3,
      preset: clean,
      gestures: printGestures(0.3),
    });
    for (const value of printed.channels[0]) assert.ok(Number.isFinite(value));
  }
  const parsed = JSON.parse(readFileSync(new URL("../presets/factory.json", import.meta.url), "utf8"));
  assert.equal(parsed[3].name, factory[3].name);
});

test("resample keeps endpoints", () => {
  const source = Float32Array.from([0, 1]);
  const out = resample([source], 2, 4);
  assert.equal(out[0].length, 4);
  assert.ok(Math.abs(out[0][0]) < 1e-6);
  assert.ok(Math.abs(out[0][3] - 1) < 1e-6);
});

test("wav export writes mono and stereo headers", () => {
  const mono = encodeWav(Float32Array.from([0, 0.5, -0.5]), 8000);
  assert.equal(String.fromCharCode(...mono.subarray(0, 4)), "RIFF");
  assert.equal(mono[22], 1);
  const stereo = encodeWavChannels([Float32Array.from([0, 0.5]), Float32Array.from([0, -0.5])], 8000);
  assert.equal(String.fromCharCode(...stereo.subarray(8, 12)), "WAVE");
  assert.equal(stereo.length, 44 + 8);
  assert.equal(stereo[22], 2);
});

test("launcher links this instrument", () => {
  const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  assert.match(html, /apps\/tape-glitch\/index\.html/);
});
