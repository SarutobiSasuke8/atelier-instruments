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

## Pump Sweep

[apps/pump-sweep](apps/pump-sweep/) ducks a loop on the grid and sweeps a filter while you hold a button.

- Pump depth, shape and note-division rate, plus an align control so the duck sits on the kick.
- Low-pass, high-pass or band-pass. The pad is cutoff and resonance.
- Build (Z, MIDI note 48), Drop (X, note 50) and Cut (C, note 52) are holds. CC 74 and CC 1 move cutoff, CC 71 moves resonance.
- Tap tempo, or detect it from the audio. Factory JSON presets ship in `presets/`.
- Export WAV renders `processPumpSweep(buffer, params)` from `engine.js`, which does not touch the DOM. Gestures printed while the transport is running are included.

## License

MIT. See [LICENSE](LICENSE).
