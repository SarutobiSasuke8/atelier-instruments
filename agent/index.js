// Atelier Instruments — MIT License
// One agent-facing API over every instrument. Node only (reads presets from disk).
//
//   listInstruments()                        -> [{ id, name, role, summary }]
//   describeInstrument(id)                   -> { ..., schema, presets, example }
//   renderInstrument(id, request)            -> { sampleRate, channels, stats, notes?, params }
//   processAudio(id, audio, request)         -> same, for processors that take audio in
//   instrumentNotes(id, request)             -> { bpm, lengthBeats, notes } for note-producing instruments
//   encodeResult(result)                     -> WAV bytes
//
// request = { preset?, params?, sampleRate? = 48000, allowSilence? = false }
// Params are checked strictly: unknown fields, wrong types and out-of-range values throw a ParamError.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ParamError, pickKnown, toJsonSchema, validate } from "../shared/params.js";
import { resampleChannels } from "../shared/resample.js";
import { encodeWavChannels } from "../shared/wav-export.js";
import { decodeWav } from "../shared/wav-decode.js";

export { ParamError, decodeWav };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = path.join(root, "apps");
export const DEFAULT_SAMPLE_RATE = 48000;
const SILENCE = 1e-4;
const MAX_SECONDS = 600;

let registry = null;

async function load() {
  if (registry) return registry;
  const found = new Map();
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(appsDir, entry.name, "agent.js");
    if (!existsSync(file)) continue;
    const descriptor = (await import(pathToFileURL(file).href)).default;
    if (!descriptor || descriptor.id !== entry.name) {
      throw new Error(`apps/${entry.name}/agent.js must export a default descriptor with id "${entry.name}"`);
    }
    found.set(descriptor.id, { ...descriptor, dir: path.join(appsDir, entry.name) });
  }
  registry = found;
  return registry;
}

async function get(id) {
  const all = await load();
  const instrument = all.get(id);
  if (!instrument) throw new ParamError([`Unknown instrument "${id}". Known: ${[...all.keys()].join(", ")}`]);
  return instrument;
}

function readPresets(instrument) {
  const dir = path.join(instrument.dir, "presets");
  if (!existsSync(dir) || !instrument.presets) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name === "index.json") continue;
    const data = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    for (const preset of instrument.presets(data, name)) {
      if (preset && preset.name) out.push({ name: preset.name, params: dropUndefined(preset.params) });
    }
  }
  return out;
}

function dropUndefined(value) {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = dropUndefined(v);
  return out;
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    const prior = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && prior && typeof prior === "object" && !Array.isArray(prior)
        ? merge(prior, value)
        : value;
  }
  return out;
}

function resolveParams(instrument, request = {}, partial = false) {
  const extra = Object.keys(request).filter((k) => !["preset", "params", "sampleRate", "allowSilence"].includes(k));
  if (extra.length) throw new ParamError([`Unknown request field(s): ${extra.join(", ")}. Put instrument settings inside params.`]);
  let base = {};
  if (request.preset !== undefined) {
    const presets = readPresets(instrument);
    const wanted = slug(request.preset);
    const match = presets.find((p) => slug(p.name) === wanted);
    if (!match) {
      throw new ParamError([`Unknown preset "${request.preset}" for ${instrument.id}. Presets: ${presets.map((p) => p.name).join(", ") || "none"}`]);
    }
    base = pickKnown(instrument.params, match.params);
  }
  const params = validate(instrument.params, merge(base, request.params || {}), { partial });
  if (partial) return params;
  const problem = instrument.check ? instrument.check(params) : null;
  if (problem) throw new ParamError([problem]);
  return params;
}

function targetRate(request) {
  const rate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
  if (![22050, 32000, 44100, 48000, 88200, 96000].includes(rate)) {
    throw new ParamError([`sampleRate must be one of 22050, 32000, 44100, 48000, 88200, 96000, got ${rate}`]);
  }
  return rate;
}

function db(value) {
  return value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : -Infinity;
}

/** Peak, RMS and length for a rendered result. */
export function measure(channels, sampleRate) {
  let peak = 0;
  let sum = 0;
  let count = 0;
  let nonFinite = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      if (!Number.isFinite(v)) {
        nonFinite += 1;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      count += 1;
    }
  }
  return {
    seconds: Math.round((channels[0].length / sampleRate) * 1000) / 1000,
    frames: channels[0].length,
    channels: channels.length,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sum / Math.max(1, count))),
    nonFinite,
  };
}

function finish(instrument, raw, params, request, rate, notes) {
  if (!raw || !Array.isArray(raw.channels) || !raw.channels.length) throw new Error(`${instrument.id} returned no audio`);
  let channels = raw.channels.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c)));
  let trimDb = 0;
  if (raw.sampleRate !== rate) {
    const before = measure(channels, raw.sampleRate).peakDb;
    channels = resampleChannels(channels, raw.sampleRate, rate);
    // Band-limited conversion shows peaks between the source samples. Bright
    // sounds can rise above the engine's ceiling, so trim only what conversion added.
    const after = measure(channels, rate).peakDb;
    const ceiling = Math.max(before, -1);
    if (after > ceiling && after > -1) {
      trimDb = Math.round((ceiling - after) * 100) / 100;
      const gain = 10 ** (trimDb / 20);
      for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
    }
  }
  const stats = measure(channels, rate);
  stats.sourceSampleRate = raw.sampleRate;
  if (trimDb) stats.conversionTrimDb = trimDb;
  if (stats.nonFinite) throw new Error(`${instrument.id} produced ${stats.nonFinite} non-finite samples`);
  if (!request.allowSilence && !(stats.peakDb > db(SILENCE))) {
    throw new Error(`${instrument.id} rendered silence (peak ${stats.peakDb} dBFS). Check the notes, levels and timing in params.`);
  }
  const result = { id: instrument.id, sampleRate: rate, channels, stats, params };
  if (notes) result.notes = notes;
  if (raw.info) result.info = raw.info;
  return result;
}

export async function listInstruments() {
  const all = await load();
  return [...all.values()].map(({ id, name, role, summary }) => ({ id, name, role, summary, notes: Boolean(findNotes(all.get(id))) }));
}

function findNotes(instrument) {
  return typeof instrument.notes === "function" ? instrument.notes : null;
}

export async function describeInstrument(id) {
  const instrument = await get(id);
  return {
    id: instrument.id,
    name: instrument.name,
    role: instrument.role,
    summary: instrument.summary,
    input: instrument.role === "processor" ? "Audio in (any WAV). Output keeps the input's channel count unless the summary says otherwise." : "None. Renders from params.",
    returnsNotes: Boolean(findNotes(instrument)),
    schema: toJsonSchema(instrument.params),
    example: instrument.example,
    presets: readPresets(instrument).map((p) => p.name),
  };
}

/** Full parameters of one preset, for an agent to copy and edit. Required fields the preset leaves out (such as notes) stay out. */
export async function presetParams(id, presetName) {
  const instrument = await get(id);
  return resolveParams(instrument, { preset: presetName }, true);
}

export async function renderInstrument(id, request = {}) {
  const instrument = await get(id);
  if (instrument.role === "processor") throw new ParamError([`${id} processes audio. Use processAudio with an input.`]);
  const params = resolveParams(instrument, request);
  const rate = targetRate(request);
  const raw = await instrument.render(params, { sampleRate: rate });
  return finish(instrument, raw, params, request, rate, raw.notes);
}

/** audio = { sampleRate, channels: Float32Array[] }, or WAV bytes. */
export async function processAudio(id, audio, request = {}) {
  const instrument = await get(id);
  if (instrument.role !== "processor") throw new ParamError([`${id} does not take audio in. Use renderInstrument.`]);
  const input = ArrayBuffer.isView(audio) || audio instanceof ArrayBuffer ? decodeWav(audio) : audio;
  if (!input || !input.sampleRate || !Array.isArray(input.channels) || !input.channels.length) {
    throw new ParamError(["audio must be WAV bytes or { sampleRate, channels }"]);
  }
  if (input.channels[0].length / input.sampleRate > MAX_SECONDS) throw new ParamError([`Input is longer than ${MAX_SECONDS} seconds.`]);
  const params = resolveParams(instrument, request);
  const rate = targetRate(request);
  const source = input.sampleRate === rate ? input : { sampleRate: rate, channels: resampleChannels(input.channels, input.sampleRate, rate) };
  const raw = await instrument.process(source, params, { sampleRate: rate });
  return finish(instrument, raw, params, request, rate);
}

export async function instrumentNotes(id, request = {}) {
  const instrument = await get(id);
  const notes = findNotes(instrument);
  if (!notes) throw new ParamError([`${id} does not produce notes.`]);
  const params = resolveParams(instrument, request);
  return { id, ...notes.call(instrument, params), params };
}

export function encodeResult(result) {
  return encodeWavChannels(result.channels, result.sampleRate);
}

/** Drop the descriptor cache. For tests that add apps at runtime. */
export function resetRegistry() {
  registry = null;
}
