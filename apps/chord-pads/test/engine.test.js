import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { encodeMidiFile } from "../../../shared/midi.js";
import { encodeWav } from "../../../shared/wav-export.js";
import {
  PAD_COUNT,
  PAD_LAYOUT,
  buildVoicing,
  describeChord,
  loopLengthBeats,
  motionBetween,
  planProgression,
  quantizeBeat,
  renderProgression,
  strumPlan,
  validateChordPreset,
  voiceLead,
} from "../engine.js";

function peak(channel) {
  let max = 0;
  for (let i = 0; i < channel.length; i++) max = Math.max(max, Math.abs(channel[i]));
  return max;
}

function rms(channel) {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  return Math.sqrt(sum / channel.length);
}

function readVarInt(bytes, offset) {
  let value = 0;
  let index = offset;
  for (let guard = 0; guard < 5; guard++) {
    const byte = bytes[index++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: index };
  }
  throw new Error("bad vlq");
}

function noteOns(bytes) {
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "MThd");
  assert.equal(String.fromCharCode(...bytes.slice(14, 18)), "MTrk");
  let index = 22;
  const notes = [];
  while (index < bytes.length) {
    const delta = readVarInt(bytes, index);
    index = delta.next;
    if (index >= bytes.length) break;
    if (bytes[index] === 0xff) {
      const type = bytes[index + 1];
      const length = readVarInt(bytes, index + 2);
      index = length.next + length.value;
      if (type === 0x2f) break;
      continue;
    }
    const status = bytes[index++];
    const command = status & 0xf0;
    if (command === 0x90 || command === 0x80) {
      const note = bytes[index++];
      const velocity = bytes[index++];
      if (command === 0x90 && velocity > 0) notes.push(note);
    } else if (command === 0xc0 || command === 0xd0) index += 1;
    else index += 2;
  }
  return notes;
}

test("sixteen pads cover distinct degree and octave pairs", () => {
  assert.equal(PAD_LAYOUT.length, PAD_COUNT);
  const keys = new Set(PAD_LAYOUT.map((pad) => `${pad.degree}:${pad.octave}`));
  assert.equal(keys.size, PAD_COUNT);
});

test("C major triad, seventh, sus, and add9", () => {
  const base = { key: "C", scale: "major", degree: 0, octave: 4, inversion: 0, spread: 0 };
  assert.deepEqual(buildVoicing({ ...base, chordType: "triad" }), [60, 64, 67]);
  assert.deepEqual(buildVoicing({ ...base, chordType: "7th" }), [60, 64, 67, 71]);
  assert.deepEqual(buildVoicing({ ...base, chordType: "sus" }), [60, 65, 67]);
  assert.deepEqual(buildVoicing({ ...base, chordType: "add9" }), [60, 64, 67, 74]);
  assert.deepEqual(buildVoicing({ ...base, chordType: "9th" }), [60, 64, 67, 71, 74]);
});

test("first inversion raises the root an octave", () => {
  const notes = buildVoicing({
    key: "C",
    scale: "major",
    degree: 0,
    octave: 4,
    chordType: "triad",
    inversion: 1,
    spread: 0,
  });
  assert.deepEqual(notes, [64, 67, 72]);
});

test("A natural minor tonic is a minor triad", () => {
  assert.deepEqual(
    buildVoicing({
      key: "A",
      scale: "naturalMinor",
      degree: 0,
      octave: 3,
      chordType: "triad",
      inversion: 0,
      spread: 0,
    }),
    [57, 60, 64],
  );
});

test("dominant in major is a dominant seventh", () => {
  const described = describeChord({
    key: "C",
    scale: "major",
    degree: 4,
    octave: 4,
    chordType: "7th",
    inversion: 0,
    spread: 0,
  });
  assert.equal(described.symbol, "G7");
  assert.equal(described.roman, "V7");
  assert.ok(described.intervals.includes(10));
  assert.ok(!described.intervals.includes(11));
});

test("spread and drop-2 change the voicing without changing the pitch classes", () => {
  const close = buildVoicing({
    key: "C",
    scale: "major",
    degree: 0,
    octave: 4,
    chordType: "triad",
    spread: 0,
  });
  const open = buildVoicing({
    key: "C",
    scale: "major",
    degree: 0,
    octave: 4,
    chordType: "triad",
    spread: 1,
  });
  const drop = buildVoicing({
    key: "C",
    scale: "major",
    degree: 0,
    octave: 4,
    chordType: "triad",
    spread: 2,
  });
  assert.notDeepEqual(open, close);
  assert.notDeepEqual(drop, close);
  const classes = (notes) => notes.map((note) => ((note % 12) + 12) % 12).sort((a, b) => a - b);
  assert.deepEqual(classes(open), classes(close));
  assert.deepEqual(classes(drop), [0, 4, 7]);
});

test("voice leading moves less than a raw parallel jump", () => {
  const spec = { key: "C", scale: "major", octave: 4, chordType: "triad", inversion: 0, spread: 0 };
  const tonic = buildVoicing({ ...spec, degree: 0 });
  const dominant = buildVoicing({ ...spec, degree: 4, voiceLeading: false });
  const led = voiceLead(dominant, tonic);
  assert.ok(motionBetween(led, tonic) < motionBetween(dominant, tonic));
});

test("strum direction and speed offset the notes", () => {
  const up = strumPlan([60, 64, 67], { speedMs: 20, direction: "up" });
  const down = strumPlan([60, 64, 67], { speedMs: 10, direction: "down" });
  const delayOf = (plan, note) => plan.find((hit) => hit.note === note).delay;
  assert.equal(delayOf(up, 60), 0);
  assert.equal(delayOf(up, 67), 0.04);
  assert.equal(delayOf(down, 67), 0);
  assert.equal(delayOf(down, 60), 0.02);
  assert.equal(delayOf(strumPlan([60, 64], { speedMs: 0, direction: "down" }), 60), 0);
});

test("quantize and loop length snap to the grid", () => {
  assert.equal(quantizeBeat(0.26, 8), 0.5);
  assert.equal(quantizeBeat(0, 16), 0);
  assert.equal(loopLengthBeats([{ startBeat: 0, durationBeats: 4 }], 4), 4);
  assert.equal(loopLengthBeats([{ startBeat: 0, durationBeats: 6 }], 4), 8);
});

test("planProgression voice-leads pad chords and emits matching MIDI notes", () => {
  const plan = planProgression(
    [
      { pad: 8, startBeat: 0, durationBeats: 2, velocity: 0.8 },
      { pad: 12, startBeat: 2, durationBeats: 2, velocity: 0.8 },
    ],
    {
      key: "C",
      scale: "major",
      chordType: "triad",
      inversion: 0,
      spread: 0,
      voiceLeading: true,
      bpm: 120,
      strum: { speedMs: 0, direction: "up" },
    },
  );
  assert.equal(plan.voiced.length, 2);
  assert.deepEqual(plan.voiced[0].notes, [48, 52, 55]);
  assert.ok(motionBetween(plan.voiced[1].notes, plan.voiced[0].notes) < 21);
  assert.equal(plan.midiEvents.length, 6);
  const file = encodeMidiFile(plan.midiEvents, { bpm: 120, trackName: "Chord Pads" });
  const ons = noteOns(file);
  assert.deepEqual(ons.slice(0, 3), [48, 52, 55]);
  assert.ok(ons.includes(47));
  assert.ok(ons.includes(50));
});

test("renderProgression is deterministic, normalized, and timbre-dependent", () => {
  const chord = [{ degree: 0, octave: 4, start: 0, duration: 0.2, velocity: 0.9 }];
  const params = {
    sampleRate: 8000,
    key: "C",
    scale: "major",
    chordType: "triad",
    sound: "piano",
    seed: 4,
    strum: { speedMs: 0, direction: "up" },
  };
  const first = renderProgression(chord, params);
  const second = renderProgression(chord, params);
  assert.equal(first.sampleRate, 8000);
  assert.deepEqual(first.left, second.left);
  assert.ok(first.left.length > 1600);
  assert.ok(rms(first.left) > 0.02);
  assert.ok(peak(first.left) <= 0.9);
  const plucked = renderProgression(chord, { ...params, sound: "pluck", seed: 4 });
  assert.notDeepEqual(plucked.left, first.left);
  const mono = new Float32Array(first.left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (first.left[i] + first.right[i]) * 0.5;
  const wav = encodeWav(mono, first.sampleRate);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
});

test("factory presets are valid and playable", () => {
  const directory = fileURLToPath(new URL("../presets/", import.meta.url));
  const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 5);
  const genres = new Set();
  for (const file of files) {
    const preset = JSON.parse(readFileSync(`${directory}/${file}`, "utf8"));
    assert.equal(validateChordPreset(preset), null);
    genres.add(preset.genre);
    const plan = planProgression(preset.progression, preset);
    assert.ok(plan.voiced.length >= 2);
    for (const chord of plan.voiced) {
      assert.ok(chord.notes.length >= 3);
      for (const note of chord.notes) {
        assert.ok(note >= 24 && note <= 108);
      }
    }
    const audio = renderProgression(preset.progression.slice(0, 1), {
      ...preset,
      sampleRate: 4000,
      strum: { ...preset.strum, speedMs: 0 },
    });
    assert.ok(rms(audio.left) > 0.01);
  }
  for (const genre of ["trance", "lo-fi", "house", "film", "pop"]) {
    assert.ok(genres.has(genre), genre);
  }
});
