// Atelier Instruments — MIT License
// 16-bit PCM WAV encoder. Safe to import from Node or the browser.

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encode mono floating-point samples in the range -1..1 as a WAV file.
 * Non-finite samples are written as silence.
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(samples, sampleRate) {
  const rate = sampleRate >>> 0;
  if (!rate) throw new Error("sampleRate must be a positive number");
  const count = samples.length >>> 0;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (let i = 0; i < count; i++) {
    let sample = Number(samples[i]);
    if (!Number.isFinite(sample)) sample = 0;
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    const int = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(offset, int, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/**
 * Start a browser download for an in-memory file.
 * No-ops outside the browser.
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {string} mime
 */
export function triggerDownload(bytes, filename, mime) {
  if (typeof document === "undefined") return;
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Download samples as a WAV file in the browser.
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {string} filename
 */
export function downloadWav(samples, sampleRate, filename) {
  triggerDownload(encodeWav(samples, sampleRate), filename, "audio/wav");
}

/**
 * Encode one or more channels as 16-bit PCM. A single channel matches the
 * mono layout of encodeWav. Extra channels are interleaved.
 * Non-finite samples are written as silence.
 * @param {ArrayLike<number>[]} channels
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWavChannels(channels, sampleRate) {
  const rate = sampleRate >>> 0;
  if (!rate) throw new Error("sampleRate must be a positive number");
  if (!channels?.length) throw new Error("encodeWavChannels needs at least one channel");
  if (channels.length === 1) return encodeWav(channels[0], rate);
  const nch = channels.length;
  const frames = channels[0].length >>> 0;
  const blockAlign = nch * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, nch, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      let sample = Number(channels[c][i]);
      if (!Number.isFinite(sample)) sample = 0;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      const int = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(offset, int, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/**
 * Download interleaved channels as a WAV file. No-ops outside the browser.
 * @param {ArrayLike<number>[]} channels
 * @param {number} sampleRate
 * @param {string} filename
 */
export function downloadWavChannels(channels, sampleRate, filename) {
  triggerDownload(encodeWavChannels(channels, sampleRate), filename, "audio/wav");
}
