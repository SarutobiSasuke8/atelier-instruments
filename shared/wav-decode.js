// Atelier Instruments — MIT License
// WAV decoder for agent and CLI processing. Safe in Node or the browser.
// Reads PCM 8, 16, 24 and 32 bit and IEEE float 32 and 64, including WAVE_FORMAT_EXTENSIBLE.

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

function text(view, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/**
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @returns {{ sampleRate: number, channels: Float32Array[], bitsPerSample: number }}
 */
export function decodeWav(bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buffer);
  if (view.byteLength < 12 || text(view, 0, 4) !== "RIFF" || text(view, 8, 4) !== "WAVE") {
    throw new Error("Not a RIFF WAVE file");
  }
  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = text(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      let tag = view.getUint16(body, true);
      const bits = view.getUint16(body + 14, true);
      if (tag === EXTENSIBLE && size >= 40) tag = view.getUint16(body + 24, true);
      format = {
        tag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits,
      };
    } else if (id === "data") {
      data = { start: body, size: Math.min(size, view.byteLength - body) };
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  const { tag, bits, blockAlign } = format;
  const count = format.channels;
  if (!count || !format.sampleRate || !blockAlign) throw new Error("WAV format chunk is invalid");
  if (!((tag === PCM && [8, 16, 24, 32].includes(bits)) || (tag === FLOAT && (bits === 32 || bits === 64)))) {
    throw new Error(`Unsupported WAV encoding: format ${tag}, ${bits} bit`);
  }
  const frames = Math.floor(data.size / blockAlign);
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  const bytesPer = bits / 8;
  for (let i = 0; i < frames; i++) {
    const frame = data.start + i * blockAlign;
    for (let c = 0; c < count; c++) {
      const at = frame + c * bytesPer;
      let value;
      if (tag === FLOAT) value = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      else if (bits === 8) value = (view.getUint8(at) - 128) / 128;
      else if (bits === 16) value = view.getInt16(at, true) / 32768;
      else if (bits === 24) {
        let v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        value = v / 8388608;
      } else value = view.getInt32(at, true) / 2147483648;
      channels[c][i] = value;
    }
  }
  return { sampleRate: format.sampleRate, channels, bitsPerSample: bits };
}
