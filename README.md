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

## License

MIT. See [LICENSE](LICENSE).
