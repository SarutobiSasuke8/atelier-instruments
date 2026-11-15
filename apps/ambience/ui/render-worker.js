/* Atelier Instruments — MIT License */
import { renderAmbience } from "../engine.js";

self.onmessage = (event) => {
  const { id, layers, seconds, seed } = event.data;
  try {
    const audio = renderAmbience(layers, seconds, seed);
    self.postMessage(
      {
        id,
        ok: true,
        sampleRate: audio.sampleRate,
        seed: audio.seed,
        left: audio.left,
        right: audio.right,
      },
      [audio.left.buffer, audio.right.buffer],
    );
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
