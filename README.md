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

## License

MIT. See [LICENSE](LICENSE).
