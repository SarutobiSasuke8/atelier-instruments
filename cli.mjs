#!/usr/bin/env node
// Atelier Instruments command line for agents and scripts.
//
//   node cli.mjs list
//   node cli.mjs describe <id>
//   node cli.mjs preset <id> <preset name>
//   node cli.mjs render <id> --out file.wav [--preset name] [--params JSON | --params @file.json] [--rate 48000]
//   node cli.mjs process <id> --in source.wav --out file.wav [--preset name] [--params ...] [--rate 48000]
//   node cli.mjs notes <id> [--preset name] [--params ...]
//
// Output is JSON on stdout. Errors are JSON on stderr with exit code 1 (2 for bad parameters).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ParamError,
  describeInstrument,
  encodeResult,
  instrumentNotes,
  listInstruments,
  presetParams,
  processAudio,
  renderInstrument,
} from "./agent/index.js";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function readParams(value) {
  if (value === undefined) return undefined;
  const text = String(value).startsWith("@") ? readFileSync(String(value).slice(1), "utf8") : String(value);
  try {
    return JSON.parse(text);
  } catch {
    throw new ParamError(["--params is not valid JSON"]);
  }
}

function request(flags) {
  const req = {};
  if (flags.preset !== undefined) req.preset = String(flags.preset);
  const params = readParams(flags.params);
  if (params !== undefined) req.params = params;
  if (flags.rate !== undefined) req.sampleRate = Number(flags.rate);
  if (flags["allow-silence"]) req.allowSilence = true;
  return req;
}

function save(result, out, force) {
  if (!out || out === true) throw new ParamError(["--out file.wav is required"]);
  if (!String(out).toLowerCase().endsWith(".wav")) throw new ParamError(["--out must end in .wav"]);
  if (existsSync(out) && !force) throw new ParamError([`${out} exists. Choose a new name or pass --force.`]);
  writeFileSync(out, encodeResult(result));
  const summary = { file: out, sampleRate: result.sampleRate, ...result.stats };
  if (result.info) summary.info = result.info;
  if (result.notes) summary.notes = result.notes;
  return summary;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, id, ...rest] = positional;
  switch (command) {
    case "list":
      return listInstruments();
    case "describe":
      return describeInstrument(id);
    case "preset":
      return presetParams(id, rest.join(" ") || flags.preset);
    case "render":
      return save(await renderInstrument(id, request(flags)), flags.out, flags.force);
    case "process": {
      if (!flags.in || flags.in === true) throw new ParamError(["--in source.wav is required"]);
      return save(await processAudio(id, readFileSync(flags.in), request(flags)), flags.out, flags.force);
    }
    case "notes":
      return instrumentNotes(id, request(flags));
    default:
      throw new ParamError([`Unknown command "${command ?? ""}". Commands: list, describe, preset, render, process, notes`]);
  }
}

main().then(
  (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  (error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message, problems: error.problems })}\n`);
    process.exit(error instanceof ParamError ? 2 : 1);
  },
);
