import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { encodeMidi, midiFromName, noteName, openAtelierBus } from "../../../shared/midi.js";
import { loadJson, parsePreset, readJsonObject, saveJson, writeJsonObject } from "../../../shared/presets.js";
import { encodeWav } from "../../../shared/wav-export.js";
import { offsetFromKey } from "../ui/keys.js";
import { renderArp } from "../engine.js";
import { renderVoices } from "../synth-offline.js";

function readVar(bytes, index) {
  let value = 0;
  let byte = 0;
  do {
    byte = bytes[index++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, index };
}

function noteOns(bytes) {
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "MThd");
  assert.equal(String.fromCharCode(...bytes.slice(14, 18)), "MTrk");
  const trackLength = (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
  const track = bytes.slice(22, 22 + trackLength);
  const notes = [];
  let index = 0;
  while (index < track.length) {
    const delta = readVar(track, index);
    index = delta.index;
    if (track[index] === 0xff) {
      index += 1;
      const type = track[index++];
      const len = readVar(track, index);
      index = len.index + (type === 0x2f ? 0 : len.value);
      if (type === 0x2f) break;
      continue;
    }
    const status = track[index];
    if ((status & 0xf0) === 0x90) {
      notes.push(track[index + 1]);
    }
    const size = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 2 : 3;
    index += size;
  }
  return notes;
}

test("midi encoder writes a playable file with tempo and note order", () => {
  const { events } = renderArp([60, 64], {
    mode: "up",
    rate: 1,
    gate: 0.5,
    length: 2,
    swing: 0,
    probability: 1,
    ratchets: 1,
  });
  const file = encodeMidi({ events, bpm: 120, name: "Arp Lab", channel: 0 });
  assert.deepEqual(noteOns(file), [60, 64]);
  assert.ok(file.includes(0xff));
  assert.equal(noteName(60), "C4");
  assert.equal(midiFromName("C4"), 60);
  assert.equal(midiFromName("Db4"), 61);
  assert.equal(midiFromName("nope"), null);
});

test("wav encoder emits a RIFF header and offline audio is audible", () => {
  const { events } = renderArp([60, 67], {
    mode: "up",
    rate: 2,
    gate: 0.8,
    length: 1,
    swing: 0,
    probability: 1,
  });
  const audio = renderVoices(events, {
    bpm: 120,
    sampleRate: 16000,
    waveform: "saw",
    cutoff: 2200,
    resonance: 0.3,
    attack: 0.005,
    decay: 0.08,
    sustain: 0.4,
    release: 0.05,
    gain: 0.9,
  });
  assert.ok(audio.length > 1000);
  assert.ok(audio.every((sample) => Number.isFinite(sample)));
  let peak = 0;
  for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak > 0.05, `peak ${peak}`);
  const wav = encodeWav(audio, 16000);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(wav.length, 44 + audio.length * 2);
});

test("factory presets are playable patterns", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "../presets/factory.json");
  const factory = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(factory.length >= 6);
  for (const preset of factory) {
    const slots = (preset.slots || []).filter((slot) => slot.length);
    const chords = preset.walk
      ? slots.map((notes, index) => ({ notes, start: index * 4, length: 4 }))
      : [{ notes: preset.sounding, start: 0, length: 4 }];
    const { events } = renderArp(chords, preset.arp);
    assert.ok(events.length > 0, preset.name);
    assert.ok(events.every((event) => event.note >= 0 && event.note <= 127 && event.duration > 0), preset.name);
  }
});

test("generic presets round-trip; creature presets stay narrow", () => {
  const preset = { name: "Night Gate", arp: { mode: "down", rate: 4 }, sounding: [60, 63, 67] };
  const parsed = readJsonObject(writeJsonObject(preset));
  assert.equal(parsed.arp.mode, "down");
  assert.deepEqual(parsed.sounding, [60, 63, 67]);
  assert.throws(() => readJsonObject("[]"));
  assert.throws(() => readJsonObject("{"));

  const creature = parsePreset(JSON.stringify({ name: "Beast", size: 2, mood: -1, arp: { mode: "up" } }));
  assert.deepEqual(Object.keys(creature).sort(), ["mood", "name", "roughness", "size", "species"]);
  assert.equal(creature.name, "Beast");
  assert.equal(creature.size, 1);
  assert.equal(creature.mood, 0);
  assert.equal(creature.arp, undefined);

  const mem = new Map();
  globalThis.localStorage = {
    getItem: (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: (key, value) => mem.set(key, String(value)),
    removeItem: (key) => mem.delete(key),
  };
  saveJson("atelier-test-preset", preset);
  assert.equal(loadJson("atelier-test-preset").name, "Night Gate");
  assert.equal(loadJson("missing", null), null);

  assert.equal(offsetFromKey({ key: "a", repeat: false, target: { tagName: "BODY" } }), 0);
  assert.equal(offsetFromKey({ key: "k", target: { tagName: "DIV" } }), 12);
  assert.equal(offsetFromKey({ key: "a", repeat: true, target: { tagName: "BODY" } }), null);
  assert.equal(offsetFromKey({ key: "a", ctrlKey: true, target: { tagName: "BODY" } }), null);
  assert.equal(offsetFromKey({ key: "a", target: { tagName: "INPUT", getAttribute: () => "text" } }), null);
  assert.equal(offsetFromKey({ key: "z", target: { tagName: "BODY" } }), null);
  const bus = openAtelierBus();
  bus.post({ type: "noteon", note: 60 });
  bus.close();
});
