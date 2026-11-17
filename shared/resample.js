// Atelier Instruments — MIT License
// Band-limited sample-rate conversion. Safe in Node or the browser.
// Windowed sinc (Blackman, 32 zero crossings each side) with the cutoff at the
// lower Nyquist, so 44.1 kHz renders reach the LMMS 48 kHz bus without imaging.

const HALF_TAPS = 32;
const TABLE_STEPS = 512;

let table = null;

function kernelTable() {
  if (table) return table;
  const size = HALF_TAPS * TABLE_STEPS + 1;
  table = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const x = i / TABLE_STEPS;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const n = x / HALF_TAPS;
    const window = 0.42 + 0.5 * Math.cos(Math.PI * n) + 0.08 * Math.cos(2 * Math.PI * n);
    table[i] = sinc * window;
  }
  return table;
}

function kernel(x) {
  const ax = Math.abs(x);
  if (ax >= HALF_TAPS) return 0;
  const t = kernelTable();
  const pos = ax * TABLE_STEPS;
  const i = Math.floor(pos);
  const frac = pos - i;
  return t[i] + (t[i + 1] - t[i]) * frac;
}

/**
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleChannel(input, fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error("Sample rates must be positive");
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = toRate / fromRate;
  const frames = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(frames);
  const scale = Math.min(1, ratio);
  const reach = HALF_TAPS / scale;
  const last = input.length - 1;
  for (let i = 0; i < frames; i++) {
    const centre = i / ratio;
    const first = Math.max(0, Math.ceil(centre - reach));
    const end = Math.min(last, Math.floor(centre + reach));
    let sum = 0;
    for (let j = first; j <= end; j++) sum += input[j] * kernel((centre - j) * scale);
    out[i] = sum * scale;
  }
  return out;
}

/** Resample every channel. */
export function resampleChannels(channels, fromRate, toRate) {
  return channels.map((channel) => resampleChannel(channel, fromRate, toRate));
}
