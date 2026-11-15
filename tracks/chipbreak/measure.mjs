// Measurement helpers for the chipbreak pack. Pure JavaScript, no engines needed.
// Nothing here listens to audio: every figure is a number computed from the samples.
// Loudness follows ITU-R BS.1770-4 (K-weighting, 400 ms blocks, -70 LUFS absolute gate, -10 LU relative gate).
// True peak uses 4x windowed-sinc interpolation. ffmpeg ebur128 is the second opinion on both (see render.mjs).

export const db = v => 20 * Math.log10(Math.max(v, 1e-12));

// ---------- K-weighting + integrated loudness ----------
function kFilters(fs) {
  const shelf = (() => {
    const G = 3.999843853973347, f0 = 1681.974450955533, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  })();
  const high = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / fs), a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return [shelf, high];
}
function biquad(x, { b, a }) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i], yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
  }
  return y;
}
// Mean-square power of the K-weighted signal in 400 ms blocks with a 100 ms hop, summed over channels.
function blockPowers(channels, fs, win = 0.4, hop = 0.1) {
  const filters = kFilters(fs);
  const weighted = channels.map(c => filters.reduce((s, f) => biquad(s, f), c));
  const w = Math.round(win * fs), h = Math.round(hop * fs), n = weighted[0].length, out = [];
  // prefix sums of squares per channel keep this O(n)
  const pre = weighted.map(c => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + c[i] * c[i]; return p; });
  for (let s = 0; s + w <= n; s += h) out.push(pre.reduce((acc, p) => acc + (p[s + w] - p[s]) / w, 0));
  return out;
}
const lufsOf = p => -0.691 + 10 * Math.log10(Math.max(p, 1e-12));
export function integratedLufs(channels, fs) {
  const powers = blockPowers(channels, fs);
  const abs = powers.filter(p => lufsOf(p) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const kept = abs.filter(p => lufsOf(p) > rel);
  return kept.length ? lufsOf(kept.reduce((a, b) => a + b, 0) / kept.length) : -Infinity;
}
// Loudness range from 3 s short-term blocks (EBU Tech 3342): 10th to 95th percentile after a -20 LU relative gate.
export function loudnessRange(channels, fs) {
  const st = blockPowers(channels, fs, 3, 0.1).filter(p => lufsOf(p) > -70);
  if (st.length < 2) return 0;
  const rel = lufsOf(st.reduce((a, b) => a + b, 0) / st.length) - 20;
  const v = st.map(lufsOf).filter(l => l > rel).sort((a, b) => a - b);
  if (v.length < 2) return 0;
  const at = f => v[Math.min(v.length - 1, Math.round(f * (v.length - 1)))];
  return at(0.95) - at(0.1);
}

// ---------- peak, true peak, flat tops, silence, NaNs ----------
export function samplePeak(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > p) p = v; }
  return p;
}
const TP_H = 8;
export const TP_PHASES = [0.25, 0.5, 0.75].map(f => {
  const k = [];
  for (let t = -TP_H + 1; t <= TP_H; t++) { const x = t - f; k.push((x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos(Math.PI * x / TP_H))); }
  return k;
});
// Largest absolute value of the 4x-oversampled signal at sample i (the sample itself and 3 points before the next one).
export function truePeakAt(x, i) {
  const n = x.length;
  let m = Math.abs(x[i]);
  for (const k of TP_PHASES) {
    let v = 0;
    for (let j = 0; j < k.length; j++) { const idx = i + j - TP_H + 1; if (idx >= 0 && idx < n) v += x[idx] * k[j]; }
    const a = Math.abs(v); if (a > m) m = a;
  }
  return m;
}
export function truePeak(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) {
    const t = truePeakAt(c, i); if (t > p) p = t;
  }
  return p;
}
export function countNonFinite(channels) {
  let n = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) n++;
  return n;
}
// Runs of at least `minRun` consecutive samples within one 16-bit step of each other at >= 90% of the peak.
// That is what hard clipping leaves behind; a limiter that works properly produces none.
export function flatTopRuns(channels, minRun = 6) {
  const peak = samplePeak(channels), lsb = 1.5 / 32767; let runs = 0;
  for (const c of channels) {
    let len = 0, last = 0;
    for (let i = 0; i < c.length; i++) {
      const v = c[i], high = Math.abs(v) >= 0.9 * peak;
      if (high && len > 0 && Math.sign(v) === Math.sign(last) && Math.abs(v - last) <= lsb) { len++; if (len === minRun) runs++; }
      else len = high ? 1 : 0;
      last = v;
    }
  }
  return runs;
}
// Bars (0-based) whose channel-0 peak stays under -60 dBFS.
export function silentBars(channels, barFrames, bars, threshold = 1e-3) {
  const out = [];
  for (let b = 0; b < bars; b++) {
    let p = 0; const a = b * barFrames;
    for (let i = a; i < Math.min(channels[0].length, a + barFrames); i++) { const v = Math.abs(channels[0][i]); if (v > p) p = v; }
    if (p < threshold) out.push(b);
  }
  return out;
}

// ---------- spectral figures for the signature checks ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
// Mono Hann-windowed spectrogram frames (size 1024, hop 512) -> band energies, spectral flux and centroid.
export function spectralProfile(channels, fs, { from = 0, to = channels[0].length } = {}) {
  const N = 1024, H = 512, win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const edges = [100, 500, 4000, 16000].map(hz => Math.round(hz / fs * N));
  const bands = [0, 0, 0, 0], flux = []; let centroidSum = 0, centroidW = 0, prev = null;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = from; s + N <= to; s += H) {
    for (let i = 0; i < N; i++) { re[i] = (channels[0][s + i] + channels[1][s + i]) * 0.5 * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let f = 0, tot = 0, cw = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]); mag[k] = m; const e = m * m; tot += e; cw += e * k * fs / N;
      const b = k < edges[0] ? 0 : k < edges[1] ? 1 : k < edges[2] ? 2 : k < edges[3] ? 3 : -1; if (b >= 0) bands[b] += e;
      if (prev) { const d = Math.log1p(m * 40) - Math.log1p(prev[k] * 40); if (d > 0) f += d; }
    }
    flux.push(f); if (tot > 0) { centroidSum += cw; centroidW += tot; }
    prev = mag;
  }
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  return { flux, hopSeconds: H / fs, bandShare: { sub: bands[0] / total, low: bands[1] / total, mid: bands[2] / total, high: bands[3] / total }, centroidHz: centroidW ? centroidSum / centroidW : 0 };
}
// Onsets per second: peaks in the flux envelope above an adaptive threshold (median + 1.5 x MAD), at least 30 ms apart.
export function onsetDensity(flux, hopSeconds) {
  if (flux.length < 8) return 0;
  const sorted = [...flux].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  const dev = flux.map(v => Math.abs(v - med)).sort((a, b) => a - b), mad = dev[dev.length >> 1];
  const thr = med + 1.5 * Math.max(mad, 1e-9) * 2, gap = Math.max(1, Math.round(0.03 / hopSeconds)); let count = 0, last = -gap;
  for (let i = 1; i < flux.length - 1; i++) if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last >= gap) { count++; last = i; }
  return count / (flux.length * hopSeconds);
}
// Tempo from the autocorrelation of the flux envelope. The score at a tempo is the mean autocorrelation at 1, 2 and 4 beats.
function tempoSeries(flux) { const n = flux.length, mean = flux.reduce((a, b) => a + b, 0) / n, x = flux.map(v => v - mean); return { n, x, zero: x.reduce((a, v) => a + v * v, 0) / n }; }
function tempoScore({ n, x }, hopSeconds, bpm) {
  const lag = 60 / bpm / hopSeconds; let sum = 0, cnt = 0;
  for (const m of [1, 2, 4]) { const l = lag * m, i0 = Math.floor(l), fr = l - i0; if (i0 + 1 >= n) continue; let s = 0; for (let i = 0; i + i0 + 1 < n; i++) s += x[i] * (x[i + i0] * (1 - fr) + x[i + i0 + 1] * fr); sum += s / (n - i0); cnt++; }
  return cnt ? sum / cnt : 0;
}
// Best tempo in [lo, hi] BPM. Returns { bpm, strength } (strength is the score over the signal variance) or null.
export function estimateTempo(flux, hopSeconds, lo = 70, hi = 200) {
  if (flux.length < 64) return null;
  const ts = tempoSeries(flux); let best = null;
  for (let bpm = lo; bpm <= hi; bpm += 0.25) { const score = tempoScore(ts, hopSeconds, bpm); if (!best || score > best.score) best = { bpm, score }; }
  return { bpm: best.bpm, strength: best.score / Math.max(ts.zero, 1e-12) };
}
// How much pulse the envelope has at the nominal tempo: the best score within +-2% of `bpm`, as a fraction of the best
// score anywhere from 60 to 220 BPM, plus where that local peak sits. 1 means the nominal grid is the strongest pulse.
export function gridLock(flux, hopSeconds, bpm) {
  if (flux.length < 64) return null;
  const ts = tempoSeries(flux); let local = null, global = -Infinity;
  for (let t = 40; t <= 420; t += 0.25) { const sc = tempoScore(ts, hopSeconds, t); if (sc > global) global = sc; if (Math.abs(t - bpm) <= bpm * 0.02 && (!local || sc > local.score)) local = { bpm: t, score: sc }; }
  return local ? { localBpm: local.bpm, relative: global > 0 ? local.score / global : 0 } : null;
}
// RMS in dBFS over a frame range (mono mix of both channels).
export function rmsDb(channels, a, b) {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i < Math.min(channels[0].length, b); i++) { const v = (channels[0][i] + channels[1][i]) * 0.5; s += v * v; n++; }
  return db(Math.sqrt(s / Math.max(n, 1)));
}
// 16-bit round trip, so figures describe the file that is written rather than the float buffer behind it.
export function quantise16(channels) {
  return channels.map(c => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))) / 32767; return o; });
}
export function encodeWav16(channels, sampleRate) {
  const frames = channels[0].length, buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[0][i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[1][i] * 32767))), 46 + i * 4);
  }
  return buf;
}
