# Atelier Instruments

A private workshop of browser instruments. Plain HTML, CSS and ES modules, the Web Audio API for playback, and no libraries or build step. Synthesis runs as ordinary JavaScript so an agent, a test, or a batch export can render audio without a browser.

Everything here is original and released under the MIT license.

## Run

```bash
npm test
npm run serve
```

`npm test` runs `node:test` for every `apps/<name>/test/*.test.js`. `npm run serve` starts a static server at the repo root (port 8080, or `PORT`).

Open the launcher, then an instrument.

- [Trailer Riser & Impact](apps/trailer-riser/) — risers, whooshes, brass hits, sub drops, reverses, and impacts. `render()` in `engine.js` returns stereo PCM with no DOM.
- [Vowel Choir Pad](apps/vowel-choir-pad/) — drag a dot across ooh, oh, ah, eh, and ee. Chords from the computer keyboard or Web MIDI. Choir size, breath, vibrato, reverb, and a sweep that glides between vowels.

## Layout

```
index.html          launcher linking to every app in apps/
shared/             wav export, presets, keyboard + Web MIDI, hardware CSS
apps/<name>/
  index.html
  engine.js         no DOM; exports a render function that returns PCM
  ui/
  presets/
  test/
```

An app may add helpers under `ui/`. Shared code is reused; don't fork it per instrument.

## Tape Glitch

`apps/tape-glitch/` drops a reel onto a broken tape machine. A demo reel loads immediately. Hold a pad or its key while the tape rolls.

| Pad | Key | What it does |
| --- | --- | --- |
| Wow | Q | Slow speed drift |
| Flutter | W | Fast scrape |
| Stop | A | Tape halt, pitch dives to silence |
| Start | S | Spin up from silence |
| Stutter | D | Repeat a slice |
| Reverse | R | Run backward |
| Crush | C | Bit depth and sample hold |
| Dropout | X | Oxide gaps |

Drag the scratch pad, or hold V and use the arrow keys. Space rolls or halts. Z randomises the trims. Escape releases every hold. Web MIDI notes 36–43 are the pads, note 48 arms scratch, and the pitch wheel or CC 1 moves the head while that note is held. CC 16–27 and CC 7 move the trims.

Export WAV bounces the performance. If you have not played yet, it prints a scripted pass. Presets are JSON.

## Game Sound Effects Maker

`apps/game-sfx/` renders jump, coin, power-up, laser, explosion, hit, pickup, menu click, error, level-up, and footstep.

`engine.js` has no DOM. `renderSfx(category, params, seed)` returns mono PCM at 44.1 kHz. The same triple always renders the same buffer. Params are `pitch`, `length`, `punch`, `noise`, `sweep`, and `style` (`0` retro, `1` modern), each from 0 to 1.

Lock keeps a take. Mutate nudges it. Revert returns to the lock. Presets are JSON. The UI pack and the platformer pack download a zip of WAVs named `ui-menu-click.wav`, `platformer-jump.wav`, and so on.

## Ambience

`apps/ambience/` layers up to six procedural textures: drone, rain, wind, cave, forest, ocean, city hum, space, and dread. Each layer has level, tone, movement, and density. Mood runs from calm to tense. Factory patches are JSON. Play and export render the same seamless loop.

```js
import { renderAmbience } from "./apps/ambience/engine.js";

const audio = renderAmbience(
  { mood: 0.2, layers: [{ kind: "ocean", level: 0.8, tone: 0.3, movement: 0.2, density: 0.5 }] },
  12,
  2048,
);
```

`audio.left` and `audio.right` are `Float32Array`s at 44100 Hz. The same seed is the same bed.

## Acid Bass Box

`apps/acid-bass/` is a mono bassline machine: saw or square oscillator, resonant 24 dB low-pass, cutoff, resonance, envelope mod, decay, accent, and drive. The sequencer has 16 steps with note, octave, accent, and slide, patterns A–D with an ordered chain, randomise-in-key, tempo, and swing. Play from the computer keyboard or Web MIDI. Internal clock can send MIDI clock, or the machine can slave to MIDI clock in. Presets are JSON. Export WAV or MIDI.

`engine.js` has no DOM. `renderAcidPattern(pattern, params)` returns `{ sampleRate, samples, duration }`. A pattern is `{ steps }` or `{ patterns: { A, B, C, D }, chain }`. Each step is `{ gate, note, octave, accent, slide }` — `note` is a pitch class 0–11 and `octave` is 0–2 above C2.

## Pump Sweep

[apps/pump-sweep](apps/pump-sweep/) ducks a loop on the grid and sweeps a filter while you hold a button.

- Pump depth, shape and note-division rate, plus an align control so the duck sits on the kick.
- Low-pass, high-pass or band-pass. The pad is cutoff and resonance.
- Build (Z, MIDI note 48), Drop (X, note 50) and Cut (C, note 52) are holds. CC 74 and CC 1 move cutoff, CC 71 moves resonance.
- Tap tempo, or detect it from the audio. Factory JSON presets ship in `presets/`.
- Export WAV renders `processPumpSweep(buffer, params)` from `engine.js`, which does not touch the DOM. Gestures printed while the transport is running are included.

## License

MIT. See [LICENSE](LICENSE).
