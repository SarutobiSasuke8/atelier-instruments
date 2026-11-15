const notes = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

export function tuningNote(hz) {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  return { note: `${notes[(nearest % 12 + 12) % 12]}${Math.floor(nearest / 12) - 1}`,
    cents: Math.round((midi - nearest) * 100) };
}

export function createPitchDetector(sampleRate, frameSize) {
  const step = Math.max(1, Math.floor(sampleRate / 10000));
  const rate = sampleRate / step;
  const signal = new Float64Array(Math.floor(frameSize / step));
  const minLag = Math.max(2, Math.floor(rate / 1400));
  const maxLag = Math.min(Math.floor(rate / 39) + 1, Math.floor(signal.length / 2));
  const curve = new Float64Array(maxLag + 1);
  const differences = new Float64Array(maxLag + 1);
  const window = Math.min(signal.length - maxLag, 2 * maxLag);

  return input => {
    let power = 0;
    for (let i = 0; i < signal.length; i++) {
      let sum = 0;
      for (let sample = 0; sample < step; sample++) sum += input[i * step + sample];
      signal[i] = sum / step;
      power += signal[i] * signal[i];
    }
    if (power / signal.length < 1e-6) return null;
    let running = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let difference = 0;
      for (let i = 0; i < window; i++) {
        const delta = signal[i] - signal[i + lag];
        difference += delta * delta;
      }
      running += difference;
      differences[lag] = difference;
      curve[lag] = running > 1e-15 ? difference * lag / running : 1;
    }
    for (let lag = minLag; lag < maxLag; lag++) {
      if (curve[lag] > .16) continue;
      while (lag < maxLag && curve[lag + 1] < curve[lag]) lag++;
      const previous = differences[lag - 1], middle = differences[lag], next = differences[lag + 1];
      const divisor = 2 * (previous - 2 * middle + next);
      const shift = lag > minLag && lag < maxLag && Math.abs(divisor) > 1e-12
        ? (previous - next) / divisor
        : 0;
      return rate / (lag + shift);
    }
    return null;
  };
}
