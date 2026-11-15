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

## Chord Pad Player

[apps/chord-pads](apps/chord-pads/index.html) is sixteen pads in a chosen key and scale. Chord color is triad, 7th, 9th, sus, or add9, with inversion, voicing spread, optional voice leading, and a strum (speed and direction). Sounds are a warm pad, a piano-like tone, a pluck, and a supersaw.

Pads answer to the pointer, the computer keys `1–4` `Q–R` `A–F` `Z–V`, and a Web MIDI note bank, and the chord can be sent to a MIDI output. A recorder stores a progression — factory sets cover trance, lo-fi, house, film, and pop — and exports JSON, WAV, and a Standard MIDI file.

`engine.js` has no DOM. `renderProgression(chords, params)` returns stereo PCM plus the voiced notes and MIDI events.

## License

MIT. See [LICENSE](LICENSE).
