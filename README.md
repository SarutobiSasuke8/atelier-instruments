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

## Arpeggiator Lab

`apps/arp-lab/` turns a held chord into a pattern. Modes are up, down, up-down, random, chord, and as-played, with rate, gate, octave range, swing, and per-step probability, ratchets, and accents. `engine.js` exports `renderArp(chords, params)` and does not touch the DOM. Hear it on the built-in synth, or send Web MIDI — and a same-origin atelier note bus — toward other instruments such as the vocoder and vowel choir. Presets are JSON. Export writes a Standard MIDI file or a WAV from the offline voice renderer.

## License

MIT. See [LICENSE](LICENSE).
