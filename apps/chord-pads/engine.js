/**
 * Chord theory, voicing, and offline rendering. MIT License.
 * No DOM and no Web Audio — safe to import from node:test.
 */

export const PAD_COUNT = 16;

/** Row-major, top to bottom. Octave is the scientific octave of the scale tonic. */
export const PAD_LAYOUT = [
  { degree: 0, octave: 4 },
  { degree: 1, octave: 4 },
  { degree: 2, octave: 4 },
  { degree: 3, octave: 4 },
  { degree: 4, octave: 4 },
  { degree: 5, octave: 4 },
  { degree: 6, octave: 4 },
  { degree: 0, octave: 5 },
  { degree: 0, octave: 3 },
  { degree: 1, octave: 3 },
  { degree: 2, octave: 3 },
  { degree: 3, octave: 3 },
  { degree: 4, octave: 3 },
  { degree: 5, octave: 3 },
  { degree: 6, octave: 3 },
  { degree: 0, octave: 2 },
];

export const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
};

export const SCALE_IDS = Object.keys(SCALES);
export const CHORD_TYPES = ["triad", "7th", "9th", "sus", "add9"];
export const SOUNDS = ["pad", "piano", "pluck", "supersaw"];

const PITCH_CLASS = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

export function pitchClass(name) {
  const value = PITCH_CLASS[name];
  if (value == null) throw new Error(`Unknown key: ${name}`);
  return value;
}

export function getScale(name) {
  const scale = SCALES[name];
  if (!scale) throw new Error(`Unknown scale: ${name}`);
  return scale;
}

export function prefersFlats(key) {
  return key.includes("b") || key === "F";
}

export function spell(pc, key = "C") {
  const names = prefersFlats(key) ? FLAT_NAMES : SHARP_NAMES;
  return names[((pc % 12) + 12) % 12];
}

export function tonicMidi(key, octave) {
  return pitchClass(key) + 12 * (octave + 1);
}

export function noteName(midi, key = "C") {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return spell(pc, key) + octave;
}

function mod(value, base) {
  return ((value % base) + base) % base;
}

function scaleTone(scale, degree, step) {
  const length = scale.length;
  const index = degree + step;
  const wrapped = mod(index, length);
  const octaves = Math.floor(index / length);
  return scale[wrapped] + octaves * 12;
}

export function chordIntervals(scaleName, degree, chordType = "triad") {
  const scale = getScale(scaleName);
  const length = scale.length;
  let extraOctave = 0;
  let stepDegree = degree;
  if (stepDegree >= length) {
    extraOctave = Math.floor(stepDegree / length);
    stepDegree = stepDegree % length;
  } else if (stepDegree < 0) {
    extraOctave = Math.floor(stepDegree / length);
    stepDegree = mod(stepDegree, length);
  }
  const steps =
    chordType === "7th"
      ? [0, 2, 4, 6]
      : chordType === "9th"
        ? [0, 2, 4, 6, 8]
        : chordType === "sus"
          ? [0, 3, 4]
          : chordType === "add9"
            ? [0, 2, 4, 8]
            : [0, 2, 4];
  return steps.map((step) => scaleTone(scale, stepDegree, step) + extraOctave * 12);
}

export function invertNotes(notes, inversion = 0) {
  const sorted = [...notes].sort((a, b) => a - b);
  const count = sorted.length || 1;
  const turns = mod(inversion | 0, count);
  const out = sorted.slice();
  for (let i = 0; i < turns; i++) out.push(out.shift() + 12);
  return out;
}

export function spreadNotes(notes, spread = 0) {
  const voiced = [...notes].sort((a, b) => a - b);
  const amount = Math.max(0, Math.min(3, spread | 0));
  if (amount === 0 || voiced.length < 2) return voiced;
  if (amount === 1) {
    voiced[voiced.length - 1] += 12;
  } else if (amount === 2) {
    if (voiced.length >= 3) voiced[voiced.length - 2] -= 12;
    else voiced[voiced.length - 1] += 12;
  } else {
    for (let i = 1; i < voiced.length; i++) {
      let guard = 0;
      while (voiced[i] <= voiced[i - 1] + 4 && guard < 6) {
        voiced[i] += 12;
        guard += 1;
      }
    }
    if (voiced.length >= 3) voiced[voiced.length - 1] += 12;
  }
  return voiced.sort((a, b) => a - b);
}

function foldMidi(note) {
  let value = Math.round(note);
  while (value > 108) value -= 12;
  while (value < 24) value += 12;
  return value;
}

function nearestPitch(anchor, pc) {
  let note = Math.round(anchor) - mod(Math.round(anchor), 12) + pc;
  while (note - anchor > 6) note -= 12;
  while (anchor - note > 6) note += 12;
  return note;
}

function assignmentCost(notes, anchors) {
  const count = notes.length;
  const used = new Array(count).fill(false);
  let best = Infinity;
  const walk = (index, cost) => {
    if (cost >= best) return;
    if (index === count) {
      best = cost;
      return;
    }
    for (let j = 0; j < count; j++) {
      if (used[j]) continue;
      used[j] = true;
      walk(index + 1, cost + Math.abs(notes[index] - anchors[j]));
      used[j] = false;
    }
  };
  walk(0, 0);
  return best;
}

function placementCost(notes, anchors) {
  const unique = new Set(notes);
  let cost = (notes.length - unique.size) * 48;
  if (notes.length === anchors.length) cost += assignmentCost(notes, anchors);
  else {
    const used = new Array(anchors.length).fill(false);
    for (const note of notes) {
      let best = Infinity;
      let index = -1;
      for (let i = 0; i < anchors.length; i++) {
        const penalty = used[i] ? 4 : 0;
        const distance = Math.abs(note - anchors[i]) + penalty;
        if (distance < best) {
          best = distance;
          index = i;
        }
      }
      if (index >= 0) used[index] = true;
      cost += best;
    }
  }
  for (const note of notes) {
    if (note < 36 || note > 96) cost += 6;
  }
  return cost;
}

/** Move `chordNotes` to the octave placement closest to `previous`. */
export function voiceLead(chordNotes, previous) {
  if (!previous?.length) return [...chordNotes].map(foldMidi).sort((a, b) => a - b);
  const pitchClasses = [];
  const seen = new Set();
  for (const note of chordNotes) {
    const pc = mod(Math.round(note), 12);
    if (seen.has(pc)) continue;
    seen.add(pc);
    pitchClasses.push(pc);
  }
  const anchors = [...previous].map(foldMidi).sort((a, b) => a - b);
  const center = anchors.reduce((sum, note) => sum + note, 0) / anchors.length;
  const choices = pitchClasses.map((pc) => {
    const mid = nearestPitch(center, pc);
    return [mid - 12, mid, mid + 12];
  });
  const current = new Array(pitchClasses.length);
  let bestNotes = null;
  let bestCost = Infinity;
  const walk = (index) => {
    if (index === pitchClasses.length) {
      const cost = placementCost(current, anchors);
      if (cost < bestCost) {
        bestCost = cost;
        bestNotes = current.slice();
      }
      return;
    }
    for (const choice of choices[index]) {
      current[index] = choice;
      walk(index + 1);
    }
  };
  walk(0);
  return (bestNotes || chordNotes).map(foldMidi).sort((a, b) => a - b);
}

export function buildVoicing(spec, previous = null) {
  const key = spec.key ?? "C";
  const scale = spec.scale ?? "major";
  const degree = spec.degree ?? 0;
  const octave = spec.octave ?? 4;
  const chordType = spec.chordType ?? "triad";
  const intervals = chordIntervals(scale, degree, chordType);
  let notes = intervals.map((semitone) => tonicMidi(key, octave) + semitone);
  notes = invertNotes(notes, spec.inversion ?? 0);
  notes = spreadNotes(notes, spec.spread ?? 0);
  if (spec.voiceLeading && previous?.length) notes = voiceLead(notes, previous);
  else notes = notes.map(foldMidi).sort((a, b) => a - b);
  return notes;
}

export function padSpec(padIndex) {
  const pad = PAD_LAYOUT[padIndex];
  if (!pad) throw new Error(`Pad ${padIndex} is out of range`);
  return pad;
}

export function strumPlan(notes, options = {}) {
  const direction = options.direction === "down" ? "down" : "up";
  const speedMs = Math.max(0, Number(options.speedMs) || 0);
  const indexed = notes.map((note, index) => ({ note, index }));
  indexed.sort((a, b) => a.note - b.note || a.index - b.index);
  const sequence = direction === "down" ? [...indexed].reverse() : indexed;
  const step = speedMs / 1000;
  const delays = new Array(notes.length).fill(0);
  sequence.forEach((item, order) => {
    delays[item.index] = order * step;
  });
  return notes.map((note, index) => ({ note, delay: delays[index] }));
}

function beatsToSeconds(beats, bpm) {
  return (beats * 60) / bpm;
}

export function quantizeBeat(beat, division = 8) {
  const safe = Number.isFinite(division) && division > 0 ? division : 8;
  const step = 4 / safe;
  const quantized = Math.round(beat / step) * step;
  return Math.round(quantized * 1000) / 1000;
}

export function loopLengthBeats(events, bar = 4) {
  let end = bar;
  for (const event of events) {
    const stop = (event.startBeat ?? 0) + (event.durationBeats ?? 0);
    if (stop > end) end = stop;
  }
  return Math.ceil((end - 1e-6) / bar) * bar;
}

function resolveDegree(chord) {
  if (chord.pad != null) {
    const pad = padSpec(chord.pad);
    return { degree: pad.degree, octave: pad.octave };
  }
  return { degree: chord.degree ?? 0, octave: chord.octave ?? 4 };
}

/**
 * Turn a progression into voiced chords and MIDI events.
 * Times are seconds. A step may carry `pad`, `degree`+`octave`, or `notes`.
 */
export function planProgression(chords, params = {}) {
  const bpm = params.bpm ?? 120;
  const voiceLeading = Boolean(params.voiceLeading);
  const strum = {
    speedMs: params.strum?.enabled === false ? 0 : params.strum?.speedMs ?? 0,
    direction: params.strum?.direction ?? "up",
  };
  const shared = {
    key: params.key ?? "C",
    scale: params.scale ?? "major",
    chordType: params.chordType ?? "triad",
    inversion: params.inversion ?? 0,
    spread: params.spread ?? 0,
    voiceLeading,
  };
  const voiced = [];
  let previous = null;
  for (const chord of chords) {
    const where = resolveDegree(chord);
    let notes;
    if (Array.isArray(chord.notes) && chord.notes.length && chord.pad == null && chord.degree == null) {
      notes = chord.notes.map(foldMidi);
      if (voiceLeading && previous) notes = voiceLead(notes, previous);
    } else {
      notes = buildVoicing(
        {
          ...shared,
          degree: where.degree,
          octave: where.octave,
          chordType: chord.chordType ?? shared.chordType,
          inversion: chord.inversion ?? shared.inversion,
          spread: chord.spread ?? shared.spread,
          voiceLeading,
        },
        previous,
      );
    }
    const start = chord.start ?? beatsToSeconds(chord.startBeat ?? 0, bpm);
    const duration = chord.duration ?? beatsToSeconds(chord.durationBeats ?? 1, bpm);
    const velocity = Math.max(0, Math.min(1, chord.velocity ?? 0.8));
    const plan = strumPlan(notes, strum);
    voiced.push({
      notes,
      start,
      duration,
      velocity,
      plan,
      pad: chord.pad ?? null,
      degree: where.degree,
      octave: where.octave,
    });
    previous = notes;
  }
  const midiEvents = [];
  for (const chord of voiced) {
    for (const hit of chord.plan) {
      midiEvents.push({
        note: hit.note,
        start: chord.start + hit.delay,
        duration: chord.duration,
        velocity: Math.max(1, Math.round(chord.velocity * 127)),
        channel: 0,
      });
    }
  }
  return { voiced, midiEvents, bpm };
}

export function voiceRecipe(sound) {
  switch (sound) {
    case "piano":
      return {
        kind: "additive",
        attack: 0.006,
        decay: 0.42,
        sustain: 0.18,
        release: 0.38,
        gain: 0.34,
        cutoff: 6400,
        partials: [
          { ratio: 1, amp: 1, decay: 1.15 },
          { ratio: 2, amp: 0.42, decay: 0.62 },
          { ratio: 3, amp: 0.2, decay: 0.38 },
          { ratio: 4, amp: 0.12, decay: 0.26 },
          { ratio: 5.02, amp: 0.07, decay: 0.18 },
          { ratio: 6.8, amp: 0.04, decay: 0.12 },
        ],
      };
    case "pluck":
      return {
        kind: "pluck",
        attack: 0.002,
        decay: 0.28,
        sustain: 0,
        release: 0.08,
        gain: 0.7,
        cutoff: 2800,
        damping: 0.992,
      };
    case "supersaw":
      return {
        kind: "saw",
        unison: 7,
        detune: 18,
        attack: 0.03,
        decay: 0.22,
        sustain: 0.72,
        release: 0.32,
        gain: 0.22,
        cutoff: 4200,
      };
    case "pad":
    default:
      return {
        kind: "saw",
        unison: 3,
        detune: 8,
        attack: 0.28,
        decay: 0.45,
        sustain: 0.78,
        release: 1.05,
        gain: 0.28,
        cutoff: 780,
      };
  }
}

function adsr(time, duration, recipe) {
  const attack = recipe.attack;
  const decay = recipe.decay;
  const sustain = recipe.sustain;
  const release = recipe.release;
  if (time < 0) return 0;
  if (time < attack) return attack <= 0 ? 1 : time / attack;
  if (time < attack + decay) {
    const mix = (time - attack) / Math.max(decay, 1e-4);
    return 1 + (sustain - 1) * mix;
  }
  if (time < duration) return sustain;
  const released = (time - duration) / Math.max(release, 1e-4);
  if (released >= 1) return 0;
  return Math.max(0, sustain * (1 - released));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderSawNote(args) {
  const { midi, startSample, duration, velocity, sampleRate, left, right, recipe } = args;
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const unison = recipe.unison ?? 1;
  const detune = recipe.detune ?? 0;
  const harmonics = Math.max(4, Math.min(recipe.cutoff > 2000 ? 14 : 8, Math.floor(sampleRate / 2 / freq)));
  const dt = 1 / sampleRate;
  const alpha = (2 * Math.PI * recipe.cutoff * dt) / (1 + 2 * Math.PI * recipe.cutoff * dt);
  let lowL = 0;
  let lowR = 0;
  const total = Math.ceil((duration + recipe.release) * sampleRate);
  const norm = recipe.gain / Math.sqrt(unison);
  for (let i = 0; i < total; i++) {
    const index = startSample + i;
    if (index >= left.length) break;
    const time = i / sampleRate;
    const envelope = adsr(time, duration, recipe);
    if (envelope <= 0) continue;
    let sampleL = 0;
    let sampleR = 0;
    for (let u = 0; u < unison; u++) {
      const spread = unison === 1 ? 0 : u / (unison - 1) - 0.5;
      const cents = spread * 2 * detune;
      const f = freq * 2 ** (cents / 1200);
      let saw = 0;
      for (let k = 1; k <= harmonics; k++) saw += Math.sin(2 * Math.PI * f * k * time) / k;
      const pan = spread;
      const gainL = Math.cos(((pan + 1) * Math.PI) / 4);
      const gainR = Math.sin(((pan + 1) * Math.PI) / 4);
      sampleL += saw * gainL;
      sampleR += saw * gainR;
    }
    lowL += alpha * (sampleL - lowL);
    lowR += alpha * (sampleR - lowR);
    const amp = envelope * velocity * norm;
    left[index] += lowL * amp;
    right[index] += lowR * amp;
  }
}

function renderAdditiveNote(args) {
  const { midi, startSample, duration, velocity, sampleRate, left, right, recipe } = args;
  const freq = 440 * 2 ** ((midi - 69) / 12);
  const total = Math.ceil((duration + recipe.release) * sampleRate);
  for (let i = 0; i < total; i++) {
    const index = startSample + i;
    if (index >= left.length) break;
    const time = i / sampleRate;
    const envelope = adsr(time, duration, recipe);
    if (envelope <= 0) continue;
    let sample = 0;
    for (const partial of recipe.partials) {
      const decay = Math.exp(-time / Math.max(0.05, partial.decay));
      sample += Math.sin(2 * Math.PI * freq * partial.ratio * time) * partial.amp * decay;
    }
    const amp = envelope * velocity * recipe.gain;
    const shaped = sample * amp;
    left[index] += shaped;
    right[index] += shaped * 0.96;
  }
}

function renderPluckNote(args) {
  const { midi, startSample, duration, velocity, sampleRate, left, right, recipe, rng } = args;
  const freq = 440 * 2 ** ((midi - 69) / 12);
  let length = Math.max(2, Math.round(sampleRate / freq));
  const buffer = new Float32Array(length);
  for (let i = 0; i < length; i++) buffer[i] = rng() * 2 - 1;
  let cursor = 0;
  const total = Math.ceil((duration + recipe.release) * sampleRate);
  const damping = recipe.damping ?? 0.992;
  for (let i = 0; i < total; i++) {
    const index = startSample + i;
    if (index >= left.length) break;
    const time = i / sampleRate;
    const a = buffer[cursor];
    const b = buffer[(cursor + 1) % length];
    const next = ((a + b) * 0.5) * damping;
    buffer[cursor] = next;
    cursor = (cursor + 1) % length;
    let envelope = 1;
    if (time > duration) envelope = Math.max(0, 1 - (time - duration) / Math.max(recipe.release, 0.02));
    const sample = next * velocity * recipe.gain * envelope;
    left[index] += sample;
    right[index] += sample * 0.9;
  }
}

function renderNote(args) {
  if (args.recipe.kind === "pluck") renderPluckNote(args);
  else if (args.recipe.kind === "additive") renderAdditiveNote(args);
  else renderSawNote(args);
}

function peakOf(left, right) {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const l = Math.abs(left[i]);
    const r = Math.abs(right[i]);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

/**
 * Render a progression to stereo PCM plus the same MIDI-ready plan.
 * `chords` entries use seconds (`start`, `duration`) or beats (`startBeat`, `durationBeats`).
 */
export function renderProgression(chords, params = {}) {
  const sampleRate = params.sampleRate ?? 44100;
  const sound = SOUNDS.includes(params.sound) ? params.sound : "pad";
  const plan = planProgression(chords, params);
  const recipe = voiceRecipe(sound);
  let end = recipe.release + 0.05;
  for (const chord of plan.voiced) {
    const strumSpan = chord.plan.reduce((max, hit) => Math.max(max, hit.delay), 0);
    end = Math.max(end, chord.start + chord.duration + strumSpan + recipe.release + 0.02);
  }
  end = Math.min(end, 8 * 60);
  const length = Math.max(1, Math.ceil(end * sampleRate));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const rng = mulberry32(params.seed ?? 1);
  for (const chord of plan.voiced) {
    for (const hit of chord.plan) {
      const start = chord.start + hit.delay;
      renderNote({
        midi: hit.note,
        startSample: Math.max(0, Math.floor(start * sampleRate)),
        duration: Math.max(0.02, chord.duration),
        velocity: chord.velocity,
        sampleRate,
        left,
        right,
        recipe,
        rng,
      });
    }
  }
  const peak = peakOf(left, right);
  if (peak > 1e-5) {
    const gain = 0.89 / peak;
    for (let i = 0; i < length; i++) {
      left[i] *= gain;
      right[i] *= gain;
    }
  }
  return {
    sampleRate,
    left,
    right,
    voiced: plan.voiced,
    midiEvents: plan.midiEvents,
  };
}

function relativePitchClasses(scaleName, degree, chordType) {
  const intervals = chordIntervals(scaleName, degree, chordType);
  const root = intervals[0];
  return intervals.map((interval) => mod(interval - root, 12));
}

export function describeChord(spec) {
  const key = spec.key ?? "C";
  const scaleName = spec.scale ?? "major";
  const chordType = spec.chordType ?? "triad";
  const scale = getScale(scaleName);
  const degree = mod(spec.degree ?? 0, Math.max(scale.length, 1));
  const relatives = relativePitchClasses(scaleName, spec.degree ?? 0, chordType);
  const has = (semitone) => relatives.includes(semitone);
  const rootOffset = chordIntervals(scaleName, spec.degree ?? 0, chordType)[0];
  const rootPc = mod(pitchClass(key) + rootOffset, 12);
  const rootName = spell(rootPc, key);
  const minorish = chordType !== "sus" && has(3) && !has(4);
  const diminished = minorish && has(6);
  const augmented = !minorish && chordType !== "sus" && has(4) && has(8);

  let quality = "";
  if (chordType === "sus") quality = "sus";
  else if (diminished) quality = "dim";
  else if (minorish) quality = "m";
  else if (augmented) quality = "aug";

  if (chordType === "7th" || chordType === "9th") {
    const ext = chordType === "9th" ? "9" : "7";
    if (diminished && has(9)) quality = `dim${ext}`;
    else if (diminished && has(10)) quality = `m${ext}b5`;
    else if (minorish && has(10)) quality = `m${ext}`;
    else if (!minorish && has(11)) quality = `maj${ext}`;
    else if (!minorish && has(10)) quality = ext;
    else quality = `${quality}${ext}`;
  } else if (chordType === "add9") {
    quality += "add9";
  }

  const romanBase = ROMAN[degree % 7] || String(degree + 1);
  let roman = minorish ? romanBase.toLowerCase() : romanBase;
  if (diminished && !quality.includes("b5")) roman += "°";
  else if (augmented) roman += "+";
  if (chordType === "7th") roman += "7";
  else if (chordType === "9th") roman += "9";
  else if (chordType === "sus") roman += "sus";
  else if (chordType === "add9") roman += "add9";

  const notes = buildVoicing({ ...spec, voiceLeading: false });
  const bassName = spell(mod(notes[0], 12), key);
  let symbol = rootName + quality;
  if (bassName !== rootName) symbol += `/${bassName}`;

  return { degree, rootPc, symbol, roman, notes, intervals: relatives };
}

export function motionBetween(a, b) {
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  const count = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < count; i++) total += Math.abs(left[i] - right[i]);
  return total;
}

export function validateChordPreset(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Preset must be a JSON object";
  if (typeof data.name !== "string" || !data.name.trim()) return "Preset needs a name";
  if (!Array.isArray(data.progression)) return "Preset needs a progression array";
  for (const step of data.progression) {
    if (!step || typeof step !== "object") return "Progression steps must be objects";
    if (!Number.isFinite(step.pad) && !Number.isFinite(step.degree) && !Array.isArray(step.notes)) {
      return "Each step needs a pad, a degree, or notes";
    }
  }
  return null;
}
