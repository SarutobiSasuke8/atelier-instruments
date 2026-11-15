# Atelier Pedalboard

The pedalboard has ten original pedals. Use Chrome or Edge for interactive audio, device selection and Web MIDI.

Set `ATELIER_DSP_ROOT` to the absolute path of a **private Atelier DSP checkout that contains the pedal DSP**. Start `npm run serve` and open the Pedalboard from the local instrument launcher. The server mounts only the pedalboard and primitive browser modules over loopback. The project does not include the private engine source. This dependency must be resolved before a public demo.

Choose **Play test phrase** for an original synthetic guitar-like phrase, or select an input and **Enable live input**. Choose your USB guitar or microphone interface in the device list. Browser permission is required. Echo cancellation, noise removal and automatic gain are disabled. Keep the output level low when using a microphone or headphones.

Drag the handle under a pedal to change the signal order, or use its arrow buttons. Click the footswitch to toggle bypass. Drag a knob vertically or use the mouse wheel and cursor keys. Shift makes finer adjustments. Double-click restores the default. The Eleven gain scale goes from 0 to 11.

Use **Connect MIDI** then **MIDI learn**, select a knob or footswitch and move a controller. Preset JSON contains order, each pedal's settings and MIDI assignments. A pedal's left arrow moves it earlier in the signal path.

## Embed in an instrument

```js
import { mountPedalboard } from '../../shared/pedalboard/board.js';
const board = await mountPedalboard({ host, context, input: instrumentOutput, destination: context.destination });
const preset = board.getState();
board.setState(preset);
```

The mount connects the given source to the chain and destination. When replacing an existing dry route, disconnect that route only after mounting succeeds. Call `board.destroy()` to detach the chain. Effects, parameter smoothing and bypass are in the private DSP package. The live module uses an AudioWorklet. The octave-down follows a single note most clearly. Art consists of original CSS and vector patch cables.

This app is awaiting art approval. The review folder contains a full board capture and a close-up of every pedal.
