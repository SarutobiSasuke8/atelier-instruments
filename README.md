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

## Creature Sound Generator

`apps/creature-sound-generator/` vocalizes game characters: grunts, growls, purrs, chirps and chatter.

- Sliders: size (tiny to huge), mood (happy, angry, scared, sleepy), species (beast, bird, insect, robot, slime), roughness.
- Performance pads: idle, attack, hurt, death, talk. Each press is a new variation.
- Keys `Q W E R T` or `1 2 3 4 5`. Space retriggers the last gesture.
- Web MIDI notes C3–G3 and C4–G4 play the five gestures. CC20 size, CC21 mood, CC22 species, CC23 roughness, CC1 grit, CC7 level.
- Export one WAV, or a zip of 10 fresh variations.
- `engine.js` exports `renderCreature(params, seed)`.

## License

MIT. See [LICENSE](LICENSE).
