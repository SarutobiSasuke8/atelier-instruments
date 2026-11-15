/* Atelier Instruments — MIT License */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KINDS, MAX_LAYERS, renderAmbience } from "../engine.js";
import { supportsMidi } from "../../../shared/midi.js";
import { presetFilename } from "../../../shared/presets.js";
import { encodeWav, encodeWavChannels } from "../../../shared/wav-export.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i += 1) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function checksum(buf) {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i += 17) {
    h ^= Math.round(buf[i] * 100000);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function assertFinite(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (!Number.isFinite(buf[i])) assert.fail("non-finite sample at " + i);
  }
}

function continuity(buf) {
  const n = buf.length;
  let acc = 0;
  const span = Math.min(4000, n - 1);
  for (let i = 1; i < span; i += 1) acc += Math.abs(buf[i] - buf[i - 1]);
  const typical = acc / span;
  const seam = Math.abs(buf[0] - buf[n - 1]);
  return { seam, typical, ratio: seam / (typical + 1e-12) };
}

const layer = (kind, extra = {}) => ({
  kind,
  level: 0.8,
  tone: 0.45,
  movement: 0.4,
  density: 0.55,
  ...extra,
});

test("renderAmbience length, stereo, and finite output", () => {
  const audio = renderAmbience({ mood: 0.2, layers: [layer("ocean"), layer("drone")] }, 0.5, 7);
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.sampleCount, 22050);
  assert.equal(audio.left.length, 22050);
  assert.equal(audio.right.length, 22050);
  assert.equal(audio.seed, 7);
  assertFinite(audio.left);
  assertFinite(audio.right);
  assert.ok(rms(audio.left) > 0.01);
});

test("same seed is deterministic and a different seed is not", () => {
  const spec = { mood: 0.4, layers: [layer("rain"), layer("wind", { level: 0.4 })] };
  const a = renderAmbience(spec, 0.35, 99);
  const b = renderAmbience(spec, 0.35, 99);
  const c = renderAmbience(spec, 0.35, 100);
  assert.equal(checksum(a.left), checksum(b.left));
  assert.equal(checksum(a.right), checksum(b.right));
  assert.notEqual(checksum(a.left), checksum(c.left));
});

test("string seeds hash and empty input is silent", () => {
  const named = renderAmbience([layer("drone")], 0.2, "lantern");
  const again = renderAmbience([layer("drone")], 0.2, "lantern");
  assert.equal(named.seed, again.seed);
  assert.notEqual(named.seed, 0);
  const silent = renderAmbience({ mood: 0.8, layers: [] }, 0.2, 1);
  assert.equal(rms(silent.left), 0);
  assert.equal(rms(silent.right), 0);
});

test("level zero is silent and louder level raises energy", () => {
  const quiet = renderAmbience([layer("drone", { level: 0 })], 0.3, 4);
  const soft = renderAmbience([layer("drone", { level: 0.25 })], 0.3, 4);
  const loud = renderAmbience([layer("drone", { level: 0.9 })], 0.3, 4);
  assert.ok(rms(quiet.left) < 1e-6);
  assert.ok(rms(loud.left) > rms(soft.left) * 1.4);
});

test("mood and a seventh layer", () => {
  const base = [layer("drone"), layer("space", { level: 0.5 })];
  const calm = renderAmbience({ mood: 0, layers: base }, 0.4, 12);
  const tense = renderAmbience({ mood: 1, layers: base }, 0.4, 12);
  assert.notEqual(checksum(calm.left), checksum(tense.left));
  assert.equal(calm.mood, 0);
  assert.equal(tense.mood, 1);
  const six = Array.from({ length: 6 }, () => layer("drone", { level: 0.3 }));
  const seven = six.concat([layer("rain", { level: 1 })]);
  const a = renderAmbience({ mood: 0.2, layers: six }, 0.25, 3);
  const b = renderAmbience({ mood: 0.2, layers: seven }, 0.25, 3);
  assert.equal(a.layers.length, MAX_LAYERS);
  assert.equal(checksum(a.left), checksum(b.left));
});

test("unknown kind falls back and bad durations throw", () => {
  const raw = renderAmbience([{ kind: "nope", level: 0.5 }], 0.2, 2);
  const drone = renderAmbience([{ kind: "drone", level: 0.5 }], 0.2, 2);
  assert.equal(raw.layers[0].kind, "drone");
  assert.equal(checksum(raw.left), checksum(drone.left));
  assert.throws(() => renderAmbience([], 0, 1), RangeError);
  assert.throws(() => renderAmbience([], -2, 1), RangeError);
  assert.throws(() => renderAmbience([], 181, 1), RangeError);
});

test("every texture kind is finite, audible, and seamless", () => {
  for (const kind of KINDS) {
    const audio = renderAmbience(
      { mood: kind === "dread" ? 0.7 : 0.3, layers: [layer(kind)] },
      1,
      21 + kind.length,
    );
    assertFinite(audio.left);
    assertFinite(audio.right);
    assert.ok(rms(audio.left) + rms(audio.right) > 0.008, kind + " was too quiet");
    const edge = continuity(audio.left);
    assert.ok(edge.ratio < 8, kind + " seam ratio " + edge.ratio.toFixed(2) + " jump " + edge.seam.toFixed(4));
    if (kind === "drone" || kind === "space") {
      assert.ok(edge.seam < 0.05, kind + " seam jump " + edge.seam);
    }
    let differ = false;
    for (let i = 0; i < 800; i += 1) {
      if (audio.left[i] !== audio.right[i]) {
        differ = true;
        break;
      }
    }
    assert.ok(differ, kind + " should be stereo");
  }
});

test("rain density thickens the texture", () => {
  const spec = (density) => [{ kind: "rain", level: 0.85, tone: 0.7, movement: 0.4, density }];
  const thin = renderAmbience({ mood: 0.3, layers: spec(0.05) }, 1.5, 50);
  const thick = renderAmbience({ mood: 0.3, layers: spec(0.95) }, 1.5, 50);
  assert.ok(rms(thick.left) > rms(thin.left) * 1.25);
});

test("wav encoder writes a matching 16-bit stereo file", () => {
  const audio = renderAmbience([layer("wind", { level: 0.6 })], 0.05, 8);
  const wav = encodeWavChannels([audio.left, audio.right], audio.sampleRate);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString(), "WAVE");
  assert.equal(wav.length, 44 + audio.sampleCount * 4);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(22, true), 2);
  const mono = encodeWav(new Float32Array([0, 0.5, -1]), 8000);
  const monoView = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
  assert.equal(monoView.getUint16(22, true), 1);
  assert.equal(monoView.getInt16(44, true), 0);
  assert.equal(monoView.getInt16(46, true), 16384);
  assert.equal(monoView.getInt16(48, true), -32768);
});

test("shipped presets render", () => {
  const dir = path.join(here, "../presets");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const preset = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    assert.equal(typeof preset.name, "string");
    assert.ok(preset.layers.length <= 6);
    const audio = renderAmbience(preset, 0.25, preset.seed ?? 1);
    assertFinite(audio.left);
    assert.ok(rms(audio.left) > 0.005, preset.name);
    assert.equal(presetFilename(preset.name).endsWith(".json"), true);
  }
});

test("shared helpers the panel relies on", () => {
  assert.equal(supportsMidi(), false);
  assert.equal(presetFilename("Night Rain"), "night-rain.json");
  assert.equal(presetFilename("Still Water"), "still-water.json");
});
