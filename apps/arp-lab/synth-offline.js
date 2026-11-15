/* Atelier Instruments — MIT License.
   Dependency-free mono render used for WAV export. Matches the panel's
   waveform, filter and envelope closely enough to audition a loop offline. */

/** Output ceiling: about -1.06 dBFS. The final tanh stage can never exceed it. */
export const OUTPUT_CEILING = 0.885;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function oscillator(phase, wave) {
  const p = phase - Math.floor(phase);
  if (wave === "square") return p < 0.5 ? 1 : -1;
  if (wave === "triangle") return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
  if (wave === "sine") return Math.sin(Math.PI * 2 * p);
  return 2 * p - 1;
}

/**
 * @param {{note:number,start:number,duration:number,velocity?:number}[]} events times in beats
 * @param {object} options
 * @returns {Float32Array}
 */
export function renderVoices(events, options = {}) {
  const sampleRate = Math.max(8000, options.sampleRate || 44100);
  const bpm = clamp(options.bpm || 120, 20, 400);
  const waveform = options.waveform || "saw";
  const cutoff = clamp(options.cutoff ?? 1800, 40, 14000);
  const resonance = clamp(options.resonance ?? 0.25, 0, 0.92);
  const attack = Math.max(0.001, options.attack ?? 0.008);
  const decay = Math.max(0.001, options.decay ?? 0.16);
  const sustain = clamp(options.sustain ?? 0.35, 0, 1);
  const release = Math.max(0.01, options.release ?? 0.2);
  const level = clamp(options.gain ?? 0.8, 0, 1);
  const secondsPerBeat = 60 / bpm;

  let tail = 0.05;
  for (const event of events) {
    const end = (Number(event.start) + Number(event.duration)) * secondsPerBeat + release;
    if (end > tail) tail = end;
  }
  const frames = Math.max(1, Math.ceil(tail * sampleRate));
  const mix = new Float32Array(frames);
  const f = 2 * Math.sin(Math.PI * Math.min(0.42, cutoff / sampleRate));
  const damp = Math.max(0.08, 1 - resonance);

  for (const event of events) {
    const note = Number(event.note);
    if (!Number.isFinite(note)) continue;
    const freq = 440 * 2 ** ((note - 69) / 12);
    const startFrame = Math.max(0, Math.floor(Number(event.start) * secondsPerBeat * sampleRate));
    const noteFrames = Math.max(1, Math.floor(Number(event.duration) * secondsPerBeat * sampleRate));
    const releaseFrames = Math.max(1, Math.floor(release * sampleRate));
    const peak = 0.22 * ((event.velocity ?? 100) / 127) * level;
    let phase = 0;
    let low = 0;
    let band = 0;
    const total = noteFrames + releaseFrames;
    for (let i = 0; i < total; i++) {
      const frame = startFrame + i;
      if (frame >= frames) break;
      const time = i / sampleRate;
      let env;
      if (time < attack) env = peak * (time / attack);
      else if (time < attack + decay) {
        const t = (time - attack) / decay;
        env = peak + (peak * sustain - peak) * t;
      } else if (i < noteFrames) env = peak * sustain;
      else env = peak * sustain * (1 - (i - noteFrames) / releaseFrames);

      const raw = oscillator(phase, waveform);
      phase += freq / sampleRate;
      if (phase >= 1) phase -= Math.floor(phase);
      const high = raw - low - damp * band;
      band += f * high;
      low += f * band;
      if (!Number.isFinite(low) || Math.abs(low) > 6) {
        low = 0;
        band = 0;
      }
      mix[frame] += low * env;
    }
  }

  // Soft limiter: unity gain at low level, never above OUTPUT_CEILING.
  for (let i = 0; i < mix.length; i++) mix[i] = OUTPUT_CEILING * Math.tanh(mix[i] / OUTPUT_CEILING);
  return mix;
}
