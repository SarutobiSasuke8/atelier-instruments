# Atelier Pedalboard

The pedalboard has eighteen original pedals. Use Chrome or Edge for interactive audio, device selection and Web MIDI.

Set `ATELIER_DSP_ROOT` to the absolute path of a **private Atelier DSP checkout that contains the pedal DSP**. Start `npm run serve` and open the Pedalboard from the local instrument launcher. The server mounts only the pedalboard and primitive browser modules over loopback. The project does not include the private engine source. This dependency must be resolved before a public demo.

Choose **Play test phrase** for an original synthetic guitar-like phrase, or select an input and **Enable live input**. Choose your USB guitar or microphone interface in the device list. Browser permission is required. Echo cancellation, noise removal and automatic gain are disabled. Keep the output level low when using a microphone or headphones.

Set input **Trim** for the signal entering the board. The **Input** and **Chain** meters show stereo sample peaks after trim and before output volume respectively. A red meter indicates a peak reached 0 dBFS. Adjust input trim or effect levels to leave headroom, then set listening level with **Output**.

Drag the handle under a pedal to change the signal order, or use its arrow buttons. Click the footswitch to toggle bypass. Drag a knob vertically or use the mouse wheel and cursor keys. Shift makes finer adjustments. Double-click restores the default. The Eleven gain scale goes from 0 to 11.

Use **Connect MIDI** then **MIDI learn**, select a knob or footswitch and move a controller. Preset JSON contains order, each pedal's settings and MIDI assignments. A pedal's left arrow moves it earlier in the signal path.

**Sunken Coil** is a modelled spring reverb. **Night Pulse** varies amplitude from smooth to chopped. **Iron Press** is a stereo-linked compressor. **Jet Mirage** is a stereo flanger. **Brick Riot** is a classic rock distortion. **Signal Lift** is a five-band graphic EQ with independent clean boost. Older ten-, thirteen- and sixteen-pedal presets load with the additional pedals bypassed.

### Tuner, looper and wah

- **Glass Meridian** listens to the dry input and mutes the pedalboard output. Engage its footswitch and play one string at a time. The display shows the nearest note and cents from A = 440 Hz. The looper keeps running while the tuner is engaged.
- **Ouroboros** records up to 30 seconds of stereo at its position in the chain. Its footswitch cycles record → play → overdub → play. Stop leaves the take available and Clear erases it. Loop audio lives in the current session. Presets store the settings and mappings.
- **Spectrum Melt** has a vertical heel-to-toe rocker, Focus and Mix controls, and a separate bypass footswitch. Drag or use the arrow keys on the rocker. To assign a physical expression pedal, choose MIDI learn, click the rocker, then move the pedal or controller.

A browser agent can drive the accessible slider or use JavaScript on the standalone local page after audio has been enabled. Embedded hosts can call the same methods on the object returned by `mountPedalboard`.

```js
window.atelierPedalboard.setWahEnabled(true);
window.atelierPedalboard.setExpression(0.25); // 0 = heel, 1 = toe
```

For a sweep, send successive positions or MIDI CC values. Browser audio and microphone permissions still apply.

## Embed in an instrument

```js
import { mountPedalboard } from '../../shared/pedalboard/board.js';
const board = await mountPedalboard({ host, context, input: instrumentOutput, destination: context.destination });
const preset = board.getState();
board.setState(preset);
```

The mount connects the given source to the chain and destination. When replacing an existing dry route, disconnect that route only after mounting succeeds. Call `board.destroy()` to detach the chain. Effects, parameter smoothing and bypass are in the private DSP package. The live module uses an AudioWorklet. The octave-down follows a single note most clearly.

The pedalboard uses original generated screen-print artwork and CSS enclosures. Barlow Condensed, Cinzel, Shrikhand and UnifrakturMaguntia are bundled locally from Google Fonts. Their SIL Open Font Licenses and credits are in [the font directory](../../shared/pedalboard/fonts).

This app is awaiting art approval. The review folder contains a full board capture and a close-up of every pedal.
