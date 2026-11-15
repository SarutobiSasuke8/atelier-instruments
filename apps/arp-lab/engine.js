/* Atelier Instruments — MIT License.
   Pattern arpeggiator. No DOM, no Web Audio.

   Times are in quarter-note beats.
   renderArp(chords, params) -> { events, stepBeats }

   chords:
     [60, 64, 67]                         one held chord, length = params.length
     [[60, 64], [62, 65]]                 sequential chords of params.length (or 4)
     [{ notes, start, length|duration }] explicit timeline

   params:
     mode            up | down | up-down | random | chord | as-played
     rate            steps per beat (4 = sixteenth notes)
     gate            0..1, fraction of the ratchet slot that sounds
     octaves         1..6, extra octaves stacked upward (down mode stacks down from the top)
     swing           0..1, delays odd steps by swing * step * 0.5
     steps           pattern length for the lanes below
     probability     number or per-step array, 0..1. Rests still advance the arp
     ratchets        number or per-step array, 1..8 repeats inside the step
     accents         number/bool or per-step array. Values >= 1 are accented
     velocity        1..127 base
     accentVelocity  1..127 when the step is accented
     seed            deterministic RNG seed for random mode and probability
     length          beats, used when chords don't carry their own length
*/

export const ARP_MODES = Object.freeze([
  "up",
  "down",
  "up-down",
  "random",
  "chord",
  "as-played",
]);

const MODE_SET = new Set(ARP_MODES);

export function defaultArpParams() {
  return {
    mode: "up",
    rate: 4,
    gate: 0.65,
    octaves: 1,
    swing: 0,
    steps: 16,
    probability: 1,
    ratchets: 1,
    accents: 0,
    velocity: 104,
    accentVelocity: 127,
    seed: 1,
    length: 4,
  };
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mod(index, length) {
  return ((index % length) + length) % length;
}

export function mulberry32(seed) {
  let a = (num(seed, 1) >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cleanNotes(notes) {
  if (!Array.isArray(notes)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of notes) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 127 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function asAccent(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return text === "1" || text === "true" || text === "accent";
  }
  return Number(value) >= 1;
}

function lane(value, steps, map, fallback) {
  const out = [];
  const source = Array.isArray(value) ? value : null;
  for (let i = 0; i < steps; i++) {
    const raw = source ? source[i % Math.max(1, source.length)] : value;
    out.push(map(raw == null ? fallback : raw));
  }
  return out;
}

export function normalizeParams(params = {}) {
  const defaults = defaultArpParams();
  const steps = clamp(Math.round(num(params.steps, defaults.steps)), 1, 64);
  const mode = MODE_SET.has(params.mode) ? params.mode : defaults.mode;
  return {
    mode,
    rate: clamp(num(params.rate, defaults.rate), 0.25, 32),
    gate: clamp(num(params.gate, defaults.gate), 0, 1),
    octaves: clamp(Math.round(num(params.octaves, defaults.octaves)), 1, 6),
    swing: clamp(num(params.swing, defaults.swing), 0, 1),
    steps,
    probability: lane(params.probability ?? defaults.probability, steps, (v) => clamp(num(v, 1), 0, 1), 1),
    ratchets: lane(params.ratchets ?? defaults.ratchets, steps, (v) => clamp(Math.round(num(v, 1)), 1, 8), 1),
    accents: lane(params.accents ?? defaults.accents, steps, (v) => asAccent(v), 0),
    velocity: clamp(Math.round(num(params.velocity, defaults.velocity)), 1, 127),
    accentVelocity: clamp(Math.round(num(params.accentVelocity, defaults.accentVelocity)), 1, 127),
    seed: num(params.seed, defaults.seed) >>> 0,
    length: Math.max(0, num(params.length, defaults.length)),
    _norm: true,
  };
}

/** Absolute start of a grid step, in beats. Odd steps are delayed by swing. */
export function stepStartBeat(stepIndex, params) {
  const p = params && params._norm ? params : normalizeParams(params);
  const step = 1 / p.rate;
  const base = stepIndex * step;
  if (stepIndex % 2 === 1) return base + p.swing * step * 0.5;
  return base;
}

export function buildSequence(notes, params) {
  const p = params && params._norm ? params : normalizeParams(params);
  let base = cleanNotes(notes);
  if (p.mode !== "as-played") base = [...base].sort((a, b) => a - b);
  if (!base.length) return [];

  const span = (down) => {
    const seq = [];
    for (let o = 0; o < p.octaves; o++) {
      const octave = down ? p.octaves - 1 - o : o;
      const row = down ? [...base].reverse() : base;
      for (const note of row) {
        const midi = note + 12 * octave;
        if (midi >= 0 && midi <= 127) seq.push(midi);
      }
    }
    return seq;
  };

  if (p.mode === "down") return span(true);
  if (p.mode === "up-down") {
    const up = span(false);
    if (up.length <= 2) return up;
    const down = [...up].reverse().slice(1, -1);
    return down.length ? up.concat(down) : up;
  }
  return span(false);
}

/**
 * Hits inside one step. `sequenceStep` picks the arp note (resets per chord).
 * `gridStep` picks swing, probability, ratchet and accent (timeline locked).
 * `rng` is consumed once for probability, and once more in random mode.
 * Returns offsets in beats relative to the step start.
 */
export function eventsForStep(notes, sequenceStep, gridStep, params, rng) {
  const p = params && params._norm ? params : normalizeParams(params);
  const sequence = buildSequence(notes, p);
  if (!sequence.length) return [];
  const random = typeof rng === "function" ? rng : mulberry32(p.seed);
  const laneIndex = mod(gridStep, p.steps);
  if (random() >= p.probability[laneIndex]) return [];

  const ratchets = p.ratchets[laneIndex];
  const accent = p.accents[laneIndex];
  const velocity = accent ? p.accentVelocity : p.velocity;
  const span = stepStartBeat(gridStep + 1, p) - stepStartBeat(gridStep, p);
  const slot = span / ratchets;
  const duration = slot * p.gate;
  if (duration <= 1e-8) return [];

  let chosen = null;
  if (p.mode === "random") {
    chosen = sequence[Math.floor(random() * sequence.length)];
  } else if (p.mode !== "chord") {
    chosen = sequence[mod(sequenceStep, sequence.length)];
  }

  const hits = [];
  for (let ratchet = 0; ratchet < ratchets; ratchet++) {
    const offset = ratchet * slot;
    if (p.mode === "chord") {
      for (const note of sequence) {
        hits.push({ note, offset, duration, velocity, ratchet, step: gridStep, accent });
      }
    } else {
      hits.push({ note: chosen, offset, duration, velocity, ratchet, step: gridStep, accent });
    }
  }
  return hits;
}

export function normalizeChords(chords, params) {
  const p = params && params._norm ? params : normalizeParams(params);
  const fallback = p.length > 0 ? p.length : 4;
  if (chords == null) return [];
  if (typeof chords === "number") {
    const notes = cleanNotes([chords]);
    return notes.length ? [{ notes, start: 0, length: fallback }] : [];
  }
  if (Array.isArray(chords) && (chords.length === 0 || typeof chords[0] === "number")) {
    return [{ notes: cleanNotes(chords), start: 0, length: fallback }];
  }
  if (!Array.isArray(chords)) {
    if (chords && Array.isArray(chords.notes)) chords = [chords];
    else return [];
  }
  let cursor = 0;
  const out = [];
  for (const chord of chords) {
    if (Array.isArray(chord)) {
      out.push({ notes: cleanNotes(chord), start: cursor, length: fallback });
      cursor += fallback;
      continue;
    }
    if (!chord || typeof chord !== "object") continue;
    const start = Math.max(0, num(chord.start ?? chord.time, cursor));
    const length = Math.max(0, num(chord.length ?? chord.duration, fallback));
    out.push({ notes: cleanNotes(chord.notes || []), start, length });
    cursor = start + length;
  }
  return out;
}

/**
 * Render an arpeggio over a chord timeline.
 * @returns {{events: {note:number,start:number,duration:number,velocity:number,step:number,ratchet:number,chordIndex:number,accent:boolean}[], stepBeats:number}}
 */
export function renderArp(chords, params = {}) {
  const p = normalizeParams(params);
  const list = normalizeChords(chords, p);
  const rng = mulberry32(p.seed);
  const events = [];
  const stepBeats = 1 / p.rate;
  const eps = Math.max(1e-9, stepBeats * 1e-6);

  for (let chordIndex = 0; chordIndex < list.length; chordIndex++) {
    const chord = list[chordIndex];
    if (!chord.notes.length || chord.length <= 0) continue;
    const end = chord.start + chord.length;
    const lastStep = Math.ceil(end / stepBeats) + 2;
    let sequenceStep = 0;
    for (let gridStep = 0; gridStep <= lastStep; gridStep++) {
      const start = stepStartBeat(gridStep, p);
      if (start >= end - eps) break;
      if (start < chord.start - eps) continue;
      const hits = eventsForStep(chord.notes, sequenceStep, gridStep, p, rng);
      sequenceStep += 1;
      for (const hit of hits) {
        const when = start + hit.offset;
        if (when >= end - eps) continue;
        const duration = Math.min(hit.duration, end - when);
        if (duration <= 1e-8) continue;
        events.push({
          note: hit.note,
          start: when,
          duration,
          velocity: hit.velocity,
          step: gridStep,
          ratchet: hit.ratchet,
          chordIndex,
          accent: hit.accent,
        });
      }
    }
  }

  return { events, stepBeats };
}
