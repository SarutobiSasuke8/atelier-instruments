# Agent API

One interface over every instrument, for agents, scripts and the LMMS MCP. Node 18 or later, no dependencies.

```js
import { listInstruments, describeInstrument, renderInstrument, processAudio, instrumentNotes, encodeResult } from "atelier-instruments/agent";

const riser = await renderInstrument("trailer-riser", { params: { kind: "riser", lengthMode: "bars", bars: 4, tempo: 128 } });
riser.stats; // { seconds, frames, channels, peakDb, rmsDb, sourceSampleRate }
fs.writeFileSync("riser.wav", encodeResult(riser));
```

## Calls

| Call | Use |
| --- | --- |
| `listInstruments()` | Every instrument with its id, role and whether it returns notes. |
| `describeInstrument(id)` | Summary, JSON Schema for params, a working example and preset names. |
| `presetParams(id, name)` | The full params of a preset, to copy and edit. |
| `renderInstrument(id, request)` | Generators. Returns `{ sampleRate, channels, stats, params, notes?, info? }`. |
| `processAudio(id, audio, request)` | Processors. `audio` is WAV bytes or `{ sampleRate, channels }`. |
| `instrumentNotes(id, request)` | Note-producing instruments. Returns `{ bpm, lengthBeats, notes: [{ midi, start, duration, velocity }] }` with times in beats and velocity from 0 to 1. |
| `encodeResult(result)` | 16-bit PCM WAV bytes. |

`request` is `{ preset?, params?, sampleRate?, allowSilence? }`. Params given with a preset override it field by field.

## Rules every call follows

- **Strict params.** Unknown fields, wrong types and out-of-range values throw a `ParamError` that names each field. The engines' own quiet clamping is never relied on.
- **48 kHz by default**, matching LMMS renders. Engines that render at a fixed 44.1 kHz are converted with a band-limited resampler. If conversion pushes a bright sound's peak above -1 dBFS, it is trimmed back and `stats.conversionTrimDb` says by how much.
- **Silence is an error.** A render that peaks below -80 dBFS throws, unless `allowSilence` is true, because an agent cannot hear that a wrong field produced nothing.
- **Deterministic.** The same params and seed give the same samples.

## Instruments

| id | Role | Notes out | Use in a track |
| --- | --- | --- | --- |
| `trailer-riser` | generator | | Risers, impacts, sub drops into section changes. Use `lengthMode: "bars"` with the song tempo. |
| `game-sfx` | generator | | Mono one-shots for game audio. |
| `creature-sound-generator` | generator | | Mono creature calls. |
| `ambience` | generator | | Seamless loop bed, up to 180 seconds. |
| `vowel-choir-pad` | generator | | Choir chord, up to 30 seconds a render. |
| `chord-pads` | generator | yes | Voiced progressions. The notes can go straight into an LMMS pattern. |
| `arp-lab` | generator | yes | Arpeggios over a chord timeline. |
| `acid-bass` | generator | yes | 303-style bassline. |
| `pump-sweep` | processor | | Sidechain pump and filter builds, drops and cuts on a stem. |
| `tape-glitch` | processor | | Tape stops, stutters, scratches and crush on a stem. |
| `robot-voice-vocoder` | processor | | Vocodes a voice recording with carrier notes. |

## CLI

```bash
node cli.mjs list
node cli.mjs describe chord-pads
node cli.mjs preset trailer-riser "Hard Cut"
node cli.mjs render trailer-riser --preset "Hard Cut" --params '{"tempo":128}' --out hit.wav
node cli.mjs process tape-glitch --in stem.wav --params @glitch.json --out stem-glitch.wav
node cli.mjs notes acid-bass --preset "Neon Alley"
```

Output is JSON on stdout. Errors are JSON on stderr: exit code 2 for bad parameters, 1 for anything else. Existing files are not overwritten without `--force`.

## Adding an instrument

Every app with an `engine.js` must ship `apps/<id>/agent.js`; a test fails otherwise. The default export is a descriptor:

```js
export default {
  id: "<folder name>",
  name, role: "generator" | "processor", summary, example,
  params: obj({ ... }),                    // specs from shared/params.js
  presets(fileJson, fileName) { return [{ name, params }]; },
  check(params) { return null or "problem"; },  // optional cross-field rules
  render(params, { sampleRate }) { return { sampleRate, channels, notes?, info? }; },   // generators
  process(audio, params, { sampleRate }) { return { sampleRate, channels }; },          // processors
  notes(params) { return { bpm, lengthBeats, notes }; },                                // optional
};
```

Keep the descriptor a thin adapter. Synthesis stays in `engine.js`.
