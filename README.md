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

## Robot Voice Vocoder

`apps/robot-voice-vocoder/`

A channel vocoder. The voice is the live microphone or a dropped WAV/MP3 (it can loop), and a built-in vowel speaks before either is connected. The carrier is a polyphonic saw, square, or supersaw with detune and unison, played from the computer keyboard, the on-screen keys, or Web MIDI, with chord hold and an arpeggiator.

The vocoder runs at 8, 16, 24, or 32 bands, with formant shift of ±12 semitones, attack, release, sibilance, noise blend, and dry/wet. Modes are robot, choir, talkbox, whisper, and monotone. Chorus, delay, and reverb sit after the mix, with a level meter and a live band display. Record the output, or export a WAV. Six JSON presets ship in `presets/`.

```js
import { renderVocoded } from "./apps/robot-voice-vocoder/engine.js";

const rendered = renderVocoded(voiceBuffer, midiNotes, preset);
```

`voiceBuffer` is a `Float32Array` or `{ samples, sampleRate }`. `midiNotes` is `[{ note, start, duration, velocity }]`. `rendered.samples` is mono PCM.

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

## License

MIT. See [LICENSE](LICENSE).
