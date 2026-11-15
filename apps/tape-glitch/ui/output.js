export function createBlocker() {
  return { x: 0, y: 0 };
}

export function dcBlock(buffer, state) {
  const r = 0.995;
  let x = state.x;
  let y = state.y;
  for (let i = 0; i < buffer.length; i++) {
    const input = buffer[i];
    y = input - x + r * y;
    x = input;
    buffer[i] = y;
  }
  state.x = x;
  state.y = y;
}

export function peakOf(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i] < 0 ? -buffer[i] : buffer[i];
    if (value > peak) peak = value;
  }
  return peak;
}
