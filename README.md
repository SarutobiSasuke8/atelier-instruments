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

## Game Sound Effects Maker

`apps/game-sfx/` renders jump, coin, power-up, laser, explosion, hit, pickup, menu click, error, level-up, and footstep.

`engine.js` has no DOM. `renderSfx(category, params, seed)` returns mono PCM at 44.1 kHz. The same triple always renders the same buffer. Params are `pitch`, `length`, `punch`, `noise`, `sweep`, and `style` (`0` retro, `1` modern), each from 0 to 1.

Lock keeps a take. Mutate nudges it. Revert returns to the lock. Presets are JSON. The UI pack and the platformer pack download a zip of WAVs named `ui-menu-click.wav`, `platformer-jump.wav`, and so on.

## License

MIT. See [LICENSE](LICENSE).
