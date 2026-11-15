import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ParamError,
  decodeWav,
  describeInstrument,
  encodeResult,
  instrumentNotes,
  listInstruments,
  presetParams,
  processAudio,
  renderInstrument,
} from "../index.js";
import { resampleChannel } from "../../shared/resample.js";
import { encodeWavChannels } from "../../shared/wav-export.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function tone(seconds = 2, rate = 48000) {
  const make = (f) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * f * i) / rate));
  return { sampleRate: rate, channels: [make(220), make(330)] };
}

function equalChannels(a, b) {
  assert.equal(a.length, b.length);
  for (let c = 0; c < a.length; c++) assert.deepEqual(a[c], b[c]);
}

const needsNotes = {
  "vowel-choir-pad": { notes: [{ midi: 57 }, { midi: 64 }], duration: 2 },
  "robot-voice-vocoder": { notes: [{ midi: 48, start: 0, duration: 1.5 }] },
};

test("every app with an engine has an agent descriptor", async () => {
  const listed = new Set((await listInstruments()).map((i) => i.id));
  for (const entry of readdirSync(path.join(root, "apps"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(path.join(root, "apps", entry.name, "engine.js"))) continue;
    assert.ok(listed.has(entry.name), `apps/${entry.name} needs an agent.js so agents and the LMMS MCP can use it`);
  }
});

test("descriptions are strict JSON Schema with a working example", async () => {
  for (const { id } of await listInstruments()) {
    const d = await describeInstrument(id);
    assert.equal(d.schema.type, "object", id);
    assert.equal(d.schema.additionalProperties, false, id);
    assert.ok(d.summary.length > 40, `${id} needs a useful summary`);
    assert.ok(d.example, `${id} needs an example`);
  }
});

test("examples render at 48 kHz, are not silent and are deterministic", async () => {
  for (const { id, role } of await listInstruments()) {
    const d = await describeInstrument(id);
    const run = () => (role === "processor" ? processAudio(id, tone(), { params: d.example }) : renderInstrument(id, { params: d.example }));
    const a = await run();
    assert.equal(a.sampleRate, 48000, id);
    assert.ok(a.stats.peakDb > -60, `${id} peak ${a.stats.peakDb}`);
    assert.ok(a.stats.peakDb <= -0.05, `${id} peak ${a.stats.peakDb} must stay under full scale`);
    equalChannels(a.channels, (await run()).channels);
  }
});

test("every factory preset resolves to valid params", async () => {
  for (const { id } of await listInstruments()) {
    const d = await describeInstrument(id);
    for (const name of d.presets) {
      const params = await presetParams(id, name);
      assert.equal(typeof params, "object", `${id} / ${name}`);
    }
  }
});

test("presets combine with caller params", async () => {
  const r = await renderInstrument("vowel-choir-pad", { preset: "Nave", params: needsNotes["vowel-choir-pad"] });
  assert.equal(r.params.choirSize, 8);
  assert.equal(r.params.notes.length, 2);
  const v = await processAudio("robot-voice-vocoder", tone(), { preset: "Glass Choir", params: needsNotes["robot-voice-vocoder"] });
  assert.ok(v.stats.peakDb > -60);
});

test("unknown fields, wrong types and ranges are rejected with the field named", async () => {
  await assert.rejects(renderInstrument("game-sfx", { params: { pitchh: 0.5 } }), (e) => e instanceof ParamError && /pitchh is not a known field/.test(e.message));
  await assert.rejects(renderInstrument("game-sfx", { params: { pitch: "high" } }), /pitch must be a number/);
  await assert.rejects(renderInstrument("game-sfx", { params: { pitch: 2 } }), /pitch must be from 0 to 1/);
  await assert.rejects(renderInstrument("game-sfx", { params: { category: "boing" } }), /category must be one of/);
  await assert.rejects(renderInstrument("vowel-choir-pad", { params: { notes: [60, 64, 67] } }), /notes\[0\] must be an object/);
  await assert.rejects(renderInstrument("chord-pads", { params: { progression: [{ pad: 0, beat: 0, beats: 4 }] } }), /beat is not a known field/);
  await assert.rejects(renderInstrument("game-sfx", { preset: "No such" }), /Unknown preset/);
  await assert.rejects(renderInstrument("nope"), /Unknown instrument/);
  await assert.rejects(renderInstrument("game-sfx", { pitch: 1 }), /Put instrument settings inside params/);
  await assert.rejects(renderInstrument("game-sfx", { sampleRate: 12345 }), /sampleRate must be one of/);
  await assert.rejects(renderInstrument("pump-sweep"), /processes audio/);
});

test("silence is an error unless allowed", async () => {
  const params = { notes: [{ midi: 60, velocity: 0 }], duration: 1 };
  await assert.rejects(renderInstrument("vowel-choir-pad", { params }), /rendered silence/);
  const quiet = await renderInstrument("vowel-choir-pad", { params, allowSilence: true });
  assert.equal(quiet.stats.peakDb, -Infinity);
});

test("note-producing instruments return beats for an LMMS pattern", async () => {
  for (const id of ["acid-bass", "chord-pads", "arp-lab"]) {
    const d = await describeInstrument(id);
    assert.equal(d.returnsNotes, true, id);
    const out = await instrumentNotes(id, { params: d.example });
    assert.ok(out.bpm > 0 && out.lengthBeats > 0, id);
    assert.ok(out.notes.length > 0, id);
    for (const n of out.notes) {
      assert.ok(Number.isInteger(n.midi) && n.start >= 0 && n.duration > 0 && n.velocity > 0 && n.velocity <= 1, `${id} ${JSON.stringify(n)}`);
    }
  }
  const acid = await instrumentNotes("acid-bass", { params: { steps: [{ gate: true, note: 3, octave: 1 }, { gate: false }] } });
  assert.deepEqual(acid.notes.map((n) => [n.midi, n.start]), [[51, 0]]);
});

test("processors accept WAV bytes and keep the input length", async () => {
  const bytes = encodeWavChannels(tone(1.5, 44100).channels, 44100);
  const out = await processAudio("tape-glitch", bytes, { params: { scripted: true } });
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.channels.length, 2);
  assert.ok(Math.abs(out.stats.seconds - 1.5) < 0.01);
});

test("WAV decode reads back what the encoder wrote", () => {
  const source = tone(0.1, 44100).channels;
  const decoded = decodeWav(encodeWavChannels(source, 44100));
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.channels.length, 2);
  for (let i = 0; i < source[0].length; i++) assert.ok(Math.abs(decoded.channels[1][i] - source[1][i]) < 1 / 16384);
});

test("resampling keeps pitch and level", () => {
  const rate = 44100;
  const input = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate));
  const out = resampleChannel(input, rate, 48000);
  assert.equal(out.length, 48000);
  let crossings = 0;
  let peak = 0;
  for (let i = 2000; i < 46000; i++) {
    if (out[i - 1] < 0 && out[i] >= 0) crossings += 1;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  assert.ok(Math.abs(crossings - 1000 * (44000 / 48000)) <= 2, `crossings ${crossings}`);
  assert.ok(Math.abs(peak - 0.5) < 0.005, `peak ${peak}`);
});

test("encodeResult writes a playable WAV", async () => {
  const r = await renderInstrument("game-sfx", { params: { category: "coin" } });
  const back = decodeWav(encodeResult(r));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.channels[0].length, r.channels[0].length);
});

test("the CLI lists, renders and reports bad params as JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "atelier-cli-"));
  try {
    const cli = path.join(root, "cli.mjs");
    const list = spawnSync(process.execPath, [cli, "list"], { encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    assert.ok(JSON.parse(list.stdout).some((i) => i.id === "trailer-riser"));
    const out = path.join(dir, "hit.wav");
    const render = spawnSync(process.execPath, [cli, "render", "trailer-riser", "--preset", "Hard Cut", "--out", out], { encoding: "utf8" });
    assert.equal(render.status, 0, render.stderr);
    assert.equal(JSON.parse(render.stdout).sampleRate, 48000);
    assert.equal(decodeWav(readFileSync(out)).sampleRate, 48000);
    const again = spawnSync(process.execPath, [cli, "render", "trailer-riser", "--out", out], { encoding: "utf8" });
    assert.equal(again.status, 2);
    const bad = spawnSync(process.execPath, [cli, "render", "game-sfx", "--params", '{"pich":1}', "--out", path.join(dir, "x.wav")], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(JSON.parse(bad.stderr).error, /pich is not a known field/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
