// Tape glitch engine. No DOM. Import from Node, a page, or an AudioWorklet.

export const EFFECTS = ["wow", "flutter", "stop", "start", "stutter", "reverse", "crush", "dropout"];

export const RANGES = {
  wowDepth: [0, 0.08],
  wowRate: [0.1, 3],
  flutterDepth: [0, 0.04],
  flutterRate: [2, 18],
  stopTime: [0.15, 3],
  startTime: [0.08, 2],
  stutterMs: [15, 400],
  crushBits: [2, 14],
  crushHold: [1, 24],
  dropoutRate: [0, 28],
  dropoutMs: [5, 180],
  dropoutDepth: [0, 1],
  gain: [0.5, 1],
};

const INTEGERS = new Set(["crushBits", "crushHold", "stutterMs", "dropoutMs"]);

export function defaultPreset() {
  return {
    name: "Bench quiet",
    wowDepth: 0.012,
    wowRate: 0.55,
    flutterDepth: 0.0045,
    flutterRate: 8.5,
    stopTime: 1.05,
    startTime: 0.62,
    stutterMs: 85,
    crushBits: 8,
    crushHold: 4,
    dropoutRate: 7,
    dropoutMs: 32,
    dropoutDepth: 0.85,
    gain: 1,
    slewMs: 10,
    edgeMs: 4,
    seed: 1,
  };
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function sanitizePreset(input, base) {
  const out = { ...defaultPreset(), ...(base || {}) };
  if (!input || typeof input !== "object") return out;
  if (typeof input.name === "string" && input.name.trim()) {
    out.name = input.name.trim().slice(0, 48);
  }
  for (const key of Object.keys(RANGES)) {
    if (input[key] == null || input[key] === "") continue;
    const number = Number(input[key]);
    if (!Number.isFinite(number)) continue;
    const [min, max] = RANGES[key];
    let next = clamp(number, min, max);
    if (INTEGERS.has(key)) next = Math.round(next);
    out[key] = next;
  }
  if (input.slewMs != null && Number.isFinite(Number(input.slewMs))) {
    out.slewMs = clamp(Number(input.slewMs), 0, 40);
  }
  if (input.edgeMs != null && Number.isFinite(Number(input.edgeMs))) {
    out.edgeMs = clamp(Number(input.edgeMs), 0, 40);
  }
  if (input.seed != null && Number.isFinite(Number(input.seed))) {
    out.seed = Number(input.seed) >>> 0;
  }
  return out;
}

export function randomizePreset(base, random = Math.random) {
  const pick = (min, max) => min + random() * (max - min);
  const draft = {
    ...(base || {}),
    name: "Random",
    wowDepth: pick(0.002, 0.075),
    wowRate: pick(0.15, 2.8),
    flutterDepth: pick(0.001, 0.036),
    flutterRate: pick(3, 16),
    stopTime: pick(0.2, 2.6),
    startTime: pick(0.12, 1.6),
    stutterMs: 18 + random() * 340,
    crushBits: 3 + Math.floor(random() * 10),
    crushHold: 1 + Math.floor(random() * 18),
    dropoutRate: pick(1, 24),
    dropoutMs: 8 + random() * 150,
    dropoutDepth: pick(0.4, 1),
    gain: pick(0.72, 1),
    seed: 1 + Math.floor(random() * 99999),
  };
  return sanitizePreset(draft);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantize(sample, bits) {
  const steps = 2 ** clamp(bits | 0, 1, 16);
  const half = steps / 2;
  const x = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(x * half) / half;
}

function asChannels(input) {
  if (!input) throw new Error("audio is missing");
  if (input instanceof Float32Array) return [input];
  if (Array.isArray(input)) {
    if (!input.length) throw new Error("audio is empty");
    return input;
  }
  throw new Error("audio must be a Float32Array or an array of channels");
}

export function resample(channels, fromRate, toRate) {
  const source = asChannels(channels);
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error("bad sample rate");
  if (fromRate === toRate) return source.map((channel) => new Float32Array(channel));
  const frames = Math.max(1, Math.round(source[0].length * (toRate / fromRate)));
  return source.map((channel) => {
    const out = new Float32Array(frames);
    const max = channel.length - 1;
    if (max <= 0) {
      out.fill(channel[0] || 0);
      return out;
    }
    const scale = (channel.length - 1) / Math.max(1, frames - 1);
    for (let i = 0; i < frames; i++) {
      const x = i * scale;
      const index = Math.floor(x);
      const frac = x - index;
      const a = channel[index] || 0;
      const b = channel[Math.min(max, index + 1)] || 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  });
}

function curveAt(curve, time) {
  if (!curve || !curve.length) return null;
  const first = curve[0];
  if (time <= first.t) return first.pos;
  const last = curve[curve.length - 1];
  if (time >= last.t) return last.pos;
  for (let i = 1; i < curve.length; i++) {
    const next = curve[i];
    if (time <= next.t) {
      const prev = curve[i - 1];
      const span = next.t - prev.t;
      const u = span <= 0 ? 0 : (time - prev.t) / span;
      return prev.pos + (next.pos - prev.pos) * u;
    }
  }
  return last.pos;
}

function blankCursor() {
  return {
    wow: false,
    flutter: false,
    stop: false,
    start: false,
    stutter: false,
    reverse: false,
    crush: false,
    dropout: false,
    scratch: null,
    scratchFreeze: false,
  };
}

function fillCursor(cursor, gestures, time) {
  cursor.wow = false;
  cursor.flutter = false;
  cursor.stop = false;
  cursor.start = false;
  cursor.stutter = false;
  cursor.reverse = false;
  cursor.crush = false;
  cursor.dropout = false;
  cursor.scratch = null;
  cursor.scratchFreeze = false;
  for (let i = 0; i < gestures.length; i++) {
    const gesture = gestures[i];
    if (time < gesture.t0 || time >= gesture.t1) continue;
    if (gesture.type === "scratch") {
      const pos = curveAt(gesture.curve, time);
      if (pos == null) cursor.scratchFreeze = true;
      else cursor.scratch = pos;
    } else if (Object.prototype.hasOwnProperty.call(cursor, gesture.type)) {
      cursor[gesture.type] = true;
    }
  }
  return cursor;
}

function readSample(channel, position, length, loop) {
  if (length <= 0) return 0;
  let x = position;
  if (loop) {
    x %= length;
    if (x < 0) x += length;
  } else if (x < 0 || x > length - 1) {
    return 0;
  }
  const index = Math.floor(x);
  const frac = x - index;
  if (frac === 0 || index >= length - 1 && !loop) return channel[index] || 0;
  const next = loop ? (index + 1) % length : Math.min(length - 1, index + 1);
  const a = channel[index] || 0;
  const b = channel[next] || 0;
  return a + (b - a) * frac;
}

export function createTapeMachine({
  channels,
  sampleRate,
  preset,
  loop = true,
  seed,
  startPosition = 0,
  rolling = false,
}) {
  const source = asChannels(channels);
  if (!source[0].length) throw new Error("tape is empty");
  if (!(sampleRate > 0)) throw new Error("sampleRate required");
  const srcLen = source[0].length;
  const nCh = source.length;
  let settings = sanitizePreset(preset);
  if (seed != null) settings = { ...settings, seed: seed >>> 0 };
  let pos = clamp(startPosition, 0, Math.max(0, srcLen - 1));
  let time = 0;
  let isRolling = !!rolling;
  const held = blankCursor();
  const onset = { stop: 0, start: 0 };
  let signed = 1;
  let wowPhase = 0;
  let flutPhase = 0;
  let stutter = null;
  let crushMix = 0;
  let holdCount = 0;
  const crushed = new Float32Array(nCh);
  const dry = new Float32Array(nCh);
  let dropLeft = 0;
  let dropGain = 1;
  const rand = mulberry32(settings.seed || 1);
  let scratchTarget = null;
  let scratchCurrent = null;
  let wasWow = false;
  let wasFlutter = false;
  let wasStop = false;
  let wasStart = false;
  let wasStutter = false;
  let wasReverse = false;
  let wasCrush = false;
  let wasDropout = false;

  function wrapStored(value) {
    if (!loop) return value;
    let x = value % srcLen;
    if (x < 0) x += srcLen;
    return x;
  }

  function renderBlock(outputs, frameCount, query) {
    const slewMs = settings.slewMs;
    const edgeMs = settings.edgeMs;
    const slew = slewMs > 0 ? 1 - Math.exp(-1 / (sampleRate * (slewMs / 1000))) : 1;
    const edge = edgeMs > 0 ? 1 - Math.exp(-1 / (sampleRate * (edgeMs / 1000))) : 1;
    const stopTime = Math.max(0.01, settings.stopTime);
    const startTime = Math.max(0.01, settings.startTime);
    const stutterLen = clamp(Math.round((settings.stutterMs / 1000) * sampleRate), 1, srcLen);
    const bits = settings.crushBits;
    const holdN = Math.max(1, settings.crushHold | 0);
    const dropRate = settings.dropoutRate;
    const dropSamples = Math.max(1, Math.round((settings.dropoutMs / 1000) * sampleRate));
    const dropDepth = settings.dropoutDepth;
    const gain = settings.gain;

    for (let i = 0; i < frameCount; i++) {
      const t = time;
      let wow = held.wow;
      let flutter = held.flutter;
      let stop = held.stop;
      let start = held.start;
      let stutterOn = held.stutter;
      let reverse = held.reverse;
      let crush = held.crush;
      let dropout = held.dropout;
      let scratchPos = null;

      if (query) {
        const cursor = query(t);
        wow = !!cursor.wow;
        flutter = !!cursor.flutter;
        stop = !!cursor.stop;
        start = !!cursor.start;
        stutterOn = !!cursor.stutter;
        reverse = !!cursor.reverse;
        crush = !!cursor.crush;
        dropout = !!cursor.dropout;
        if (cursor.scratchFreeze) scratchPos = srcLen <= 1 ? 0 : pos / (srcLen - 1);
        else if (cursor.scratch != null) scratchPos = clamp(cursor.scratch, 0, 1);
      } else if (!isRolling && scratchTarget == null) {
        for (let c = 0; c < nCh; c++) outputs[c][i] = 0;
        continue;
      } else if (scratchTarget == null) {
        scratchCurrent = null;
      } else {
        if (scratchCurrent == null) scratchCurrent = scratchTarget;
        scratchCurrent += (scratchTarget - scratchCurrent) * 0.35;
        scratchPos = scratchCurrent;
      }

      const riseStop = stop && !wasStop;
      const riseStart = start && !wasStart;
      const riseStutter = stutterOn && !wasStutter;
      const riseCrush = crush && !wasCrush;
      if (riseStop) onset.stop = t;
      if (riseStart) onset.start = t;
      if (!stutterOn && wasStutter && stutter) {
        pos = wrapStored(stutter.start + stutter.phase);
        stutter = null;
      }
      if (riseStutter) {
        stutter = { start: wrapStored(pos), phase: 0, len: stutterLen };
      }

      let env = 1;
      if (stop) {
        const u = (t - onset.stop) / stopTime;
        env = u >= 1 ? 0 : Math.pow(1 - Math.max(0, u), 1.7);
      }
      if (start) {
        const u = (t - onset.start) / startTime;
        const shaped = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
        env *= shaped;
      }
      let mod = 1;
      if (wow) mod *= 1 + clamp(settings.wowDepth, 0, 1) * Math.sin(2 * Math.PI * wowPhase);
      if (flutter) {
        const a = Math.sin(2 * Math.PI * flutPhase);
        const b = Math.sin(2 * Math.PI * flutPhase * 2.37 + 1.2);
        mod *= 1 + clamp(settings.flutterDepth, 0, 1) * (0.72 * a + 0.28 * b);
      }
      wowPhase += settings.wowRate / sampleRate;
      if (wowPhase >= 1) wowPhase -= 1;
      flutPhase += settings.flutterRate / sampleRate;
      if (flutPhase >= 1) flutPhase -= 1;

      const dir = reverse ? -1 : 1;
      const target = env * mod * dir;
      if (riseStart) signed = 0;
      else if (slew >= 1) signed = target;
      else signed += (target - signed) * slew;

      if (scratchPos != null) pos = scratchPos * Math.max(0, srcLen - 1);

      const frozen = scratchPos == null && Math.abs(signed) < 1e-4;
      if (frozen) {
        for (let c = 0; c < nCh; c++) dry[c] = 0;
      } else if (stutter && stutterOn && scratchPos == null) {
        const at = stutter.start + stutter.phase;
        for (let c = 0; c < nCh; c++) dry[c] = readSample(source[c], at, srcLen, loop);
        stutter.phase += signed;
        const len = stutter.len;
        stutter.phase %= len;
        if (stutter.phase < 0) stutter.phase += len;
      } else {
        for (let c = 0; c < nCh; c++) dry[c] = readSample(source[c], pos, srcLen, loop);
        if (scratchPos == null) pos = wrapStored(pos + signed);
      }

      if (riseCrush) holdCount = 0;
      const crushTarget = crush ? 1 : 0;
      if (edge >= 1) crushMix = crushTarget;
      else crushMix += (crushTarget - crushMix) * edge;
      if (crushMix > 0) {
        if (holdCount <= 0) {
          for (let c = 0; c < nCh; c++) crushed[c] = quantize(dry[c], bits);
          holdCount = holdN;
        }
        holdCount -= 1;
      }

      if (dropout && dropLeft <= 0 && rand() < dropRate / sampleRate) dropLeft = dropSamples;
      const gate = dropLeft > 0 ? dropDepth : 0;
      if (dropLeft > 0) dropLeft -= 1;
      const dropTarget = 1 - gate;
      if (edge >= 1) dropGain = dropTarget;
      else dropGain += (dropTarget - dropGain) * edge;

      let amp = 1;
      if (stop && scratchPos == null) {
        const u = (t - onset.stop) / stopTime;
        if (u >= 1) amp = 0;
        else if (u > 0.82) amp = 1 - (u - 0.82) / 0.18;
      }

      for (let c = 0; c < nCh; c++) {
        let sample = dry[c];
        if (crushMix > 0) sample = sample * (1 - crushMix) + crushed[c] * crushMix;
        sample *= dropGain * amp * gain;
        if (sample > 1) sample = 1;
        else if (sample < -1) sample = -1;
        outputs[c][i] = sample;
      }

      wasWow = wow;
      wasFlutter = flutter;
      wasStop = stop;
      wasStart = start;
      wasStutter = stutterOn;
      wasReverse = reverse;
      wasCrush = crush;
      wasDropout = dropout;
      time += 1 / sampleRate;
    }
  }

  return {
    setPreset(next) {
      settings = sanitizePreset(next, settings);
      return settings;
    },
    getPreset() {
      return { ...settings };
    },
    setRolling(value) {
      isRolling = !!value;
    },
    isRolling() {
      return isRolling;
    },
    hold(name, down) {
      if (Object.prototype.hasOwnProperty.call(held, name)) held[name] = !!down;
    },
    setScratch(value) {
      if (value == null) {
        scratchTarget = null;
        return;
      }
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      scratchTarget = clamp(number, 0, 1);
      if (scratchCurrent == null) scratchCurrent = scratchTarget;
    },
    isScratching() {
      return scratchTarget != null;
    },
    seek(norm) {
      const n = clamp(Number(norm) || 0, 0, 1);
      pos = n * Math.max(0, srcLen - 1);
    },
    getHead() {
      if (srcLen <= 1) return 0;
      let head = pos / (srcLen - 1);
      if (head < 0) head = 0;
      if (head > 1) head = 1;
      return head;
    },
    getTime() {
      return time;
    },
    renderBlock,
  };
}

export function render({
  input,
  channels,
  sampleRate,
  preset,
  gestures = [],
  duration,
  loop = true,
  seed,
  startPosition = 0,
}) {
  const source = asChannels(channels || input);
  if (!(sampleRate > 0)) throw new Error("sampleRate required");
  const seconds = duration == null ? source[0].length / sampleRate : duration;
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  const machine = createTapeMachine({
    channels: source,
    sampleRate,
    preset,
    loop,
    seed,
    startPosition,
    rolling: true,
  });
  const outputs = source.map(() => new Float32Array(frames));
  const cursor = blankCursor();
  machine.renderBlock(outputs, frames, (t) => fillCursor(cursor, gestures, t));
  return { sampleRate, channels: outputs, length: frames };
}

export function printGestures(duration) {
  const d = Math.max(0, duration);
  return [
    { type: "wow", t0: d * 0.02, t1: d * 0.38 },
    { type: "flutter", t0: d * 0.18, t1: d * 0.46 },
    {
      type: "scratch",
      t0: d * 0.3,
      t1: d * 0.42,
      curve: [
        { t: d * 0.3, pos: 0.2 },
        { t: d * 0.36, pos: 0.8 },
        { t: d * 0.42, pos: 0.35 },
      ],
    },
    { type: "stutter", t0: d * 0.4, t1: d * 0.55 },
    { type: "crush", t0: d * 0.5, t1: d * 0.72 },
    { type: "reverse", t0: d * 0.62, t1: d * 0.78 },
    { type: "dropout", t0: d * 0.74, t1: d * 0.9 },
    { type: "stop", t0: d * 0.88, t1: d },
  ];
}

export function makeDemoReel(sampleRate = 44100) {
  const rate = sampleRate > 0 ? sampleRate : 44100;
  const bpm = 98;
  const beat = (60 / bpm) * rate;
  const bars = 4;
  const frames = Math.floor(beat * 4 * bars);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const rand = mulberry32(0x51a7);
  const notes = [0, 0, 3, 7, 10, 7, 3, 0, -2, 0, 5, 7, 10, 7, 3, -5];
  const eighth = beat / 2;
  let bassPhase = 0;

  function add(index, sample, pan) {
    if (index < 0 || index >= frames) return;
    const angle = ((pan + 1) * Math.PI) / 4;
    left[index] += sample * Math.cos(angle);
    right[index] += sample * Math.sin(angle);
  }

  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const beatPos = i / beat;
    const bar = Math.floor(beatPos / 4);
    const within = beatPos - bar * 4;
    const kickT = (within - Math.floor(within)) * beat / rate;
    if (kickT >= 0 && kickT < 0.2) {
      const freq = 148 * (42 / 148) ** (kickT / 0.2);
      const env = Math.exp(-kickT * 16);
      add(i, Math.sin(2 * Math.PI * freq * kickT) * env * 0.85, 0);
    }

    for (const snareBeat of [1, 3]) {
      const snareT = (within - snareBeat) * beat / rate;
      if (snareT >= 0 && snareT < 0.16) {
        const env = Math.exp(-snareT * 22);
        const noise = rand() * 2 - 1;
        const tone = Math.sin(2 * Math.PI * 188 * snareT);
        add(i, (noise * 0.65 + tone * 0.35) * env * 0.38, 0.05);
      }
    }

    const hatSlot = Math.floor(i / eighth);
    const hatT = (i - hatSlot * eighth) / rate;
    if (hatT < 0.035) {
      const env = Math.exp(-hatT * 90);
      const accent = hatSlot % 2 === 0 ? 0.16 : 0.08;
      add(i, (rand() * 2 - 1) * env * accent, -0.25);
    }

    const step = Math.floor(i / eighth);
    const semis = notes[step % notes.length];
    const freq = 110 * 2 ** (semis / 12);
    bassPhase += freq / rate;
    const local = (i % eighth) / eighth;
    const env = 0.82 + 0.18 * (1 - local);
    const bass = Math.sin(2 * Math.PI * bassPhase) * 0.22 * env;
    add(i, bass, 0);

    if (step % 8 === 4) {
      const stabT = (i - step * eighth) / rate;
      if (stabT >= 0 && stabT < 0.12) {
        const env = Math.exp(-stabT * 14);
        const root = 220 * 2 ** (semis / 12);
        const chord =
          Math.sin(2 * Math.PI * root * stabT) +
          Math.sin(2 * Math.PI * root * 1.189 * stabT) +
          Math.sin(2 * Math.PI * root * 1.498 * stabT);
        add(i, chord * env * 0.045, 0.35);
        add(i + Math.round(rate * 0.012), chord * env * 0.03, -0.4);
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const gain = peak > 0.001 ? 0.8 / peak : 1;
  for (let i = 0; i < frames; i++) {
    left[i] *= gain;
    right[i] *= gain;
  }
  return { channels: [left, right], sampleRate: rate, name: "Demo reel" };
}
