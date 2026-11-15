import assert from "node:assert/strict";
import test from "node:test";
import {
  ARP_MODES,
  buildSequence,
  renderArp,
} from "../engine.js";

function notesOf(result) {
  return result.events.map((event) => event.note);
}

function near(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !~ ${expected}`);
}

const straight = {
  swing: 0,
  gate: 0.5,
  octaves: 1,
  steps: 8,
  probability: 1,
  ratchets: 1,
  accents: 0,
  velocity: 100,
  accentVelocity: 120,
  seed: 1,
};

test("renderArp walks a chord upward in played order of sorted notes", () => {
  const result = renderArp([60, 67, 64], { ...straight, mode: "up", rate: 4, length: 1 });
  assert.deepEqual(notesOf(result), [60, 64, 67, 60]);
  near(result.stepBeats, 0.25);
  near(result.events[0].start, 0);
  near(result.events[1].start, 0.25);
  near(result.events[2].start, 0.5);
  near(result.events[3].start, 0.75);
  near(result.events[0].duration, 0.125);
  assert.equal(result.events[0].velocity, 100);
});

test("down mode starts at the top and keeps octave copies above the chord", () => {
  const seq = buildSequence([60, 64], { mode: "down", octaves: 2, steps: 4 });
  assert.deepEqual(seq, [76, 72, 64, 60]);
  const result = renderArp([60, 64], { ...straight, mode: "down", octaves: 1, rate: 4, length: 1 });
  assert.deepEqual(notesOf(result), [64, 60, 64, 60]);
});

test("up-down turns around without repeating the top note", () => {
  const seq = buildSequence([60, 64, 67], { mode: "up-down", octaves: 1, steps: 4 });
  assert.deepEqual(seq, [60, 64, 67, 64]);
  const result = renderArp([60, 64, 67], {
    ...straight,
    mode: "up-down",
    rate: 4,
    length: 2,
  });
  assert.deepEqual(notesOf(result), [60, 64, 67, 64, 60, 64, 67, 64]);
});

test("as-played keeps the order notes arrived in", () => {
  const result = renderArp([67, 60, 64], {
    ...straight,
    mode: "as-played",
    rate: 4,
    length: 1,
  });
  assert.deepEqual(notesOf(result), [67, 60, 64, 67]);
});

test("chord mode stacks every note on the same step", () => {
  const result = renderArp([60, 64, 67], {
    ...straight,
    mode: "chord",
    rate: 1,
    gate: 1,
    length: 1,
  });
  assert.equal(result.events.length, 3);
  for (const event of result.events) {
    near(event.start, 0);
    near(event.duration, 1);
  }
  assert.deepEqual(notesOf(result).sort((a, b) => a - b), [60, 64, 67]);
});

test("octave range extends the cycle upward", () => {
  const result = renderArp([60, 64, 67], {
    ...straight,
    mode: "up",
    octaves: 2,
    rate: 2,
    length: 3,
  });
  assert.deepEqual(notesOf(result), [60, 64, 67, 72, 76, 79]);
});

test("swing delays odd steps and squeezes the following gap", () => {
  const result = renderArp([60], {
    ...straight,
    mode: "up",
    rate: 2,
    swing: 1,
    gate: 1,
    length: 2,
  });
  const starts = result.events.map((event) => event.start);
  assert.equal(starts.length, 4);
  near(starts[0], 0);
  near(starts[1], 0.75);
  near(starts[2], 1);
  near(starts[3], 1.75);
  near(result.events[0].duration, 0.75);
  near(result.events[1].duration, 0.25);
});

test("per-step probability rests still advance the pattern", () => {
  const silent = renderArp([60, 64, 67], {
    ...straight,
    mode: "up",
    rate: 4,
    length: 1,
    probability: 0,
  });
  assert.equal(silent.events.length, 0);

  const gated = renderArp([60, 64, 67], {
    ...straight,
    mode: "up",
    rate: 4,
    length: 1,
    steps: 4,
    probability: [1, 0, 1, 0],
  });
  assert.deepEqual(notesOf(gated), [60, 67]);
  near(gated.events[0].start, 0);
  near(gated.events[1].start, 0.5);
});

test("ratchets retrigger the same arp note inside the step", () => {
  const result = renderArp([60, 64], {
    ...straight,
    mode: "up",
    rate: 1,
    gate: 0.5,
    length: 2,
    steps: 2,
    ratchets: [2, 1],
  });
  assert.deepEqual(notesOf(result), [60, 60, 64]);
  near(result.events[0].start, 0);
  near(result.events[1].start, 0.5);
  near(result.events[0].duration, 0.25);
  near(result.events[2].start, 1);
  assert.equal(result.events[0].ratchet, 0);
  assert.equal(result.events[1].ratchet, 1);
});

test("accents raise velocity on marked steps only", () => {
  const result = renderArp([60], {
    ...straight,
    mode: "up",
    rate: 1,
    length: 4,
    steps: 4,
    accents: [1, 0, true, 0],
    velocity: 80,
    accentVelocity: 127,
  });
  assert.deepEqual(
    result.events.map((event) => event.velocity),
    [127, 80, 127, 80],
  );
});

test("a zero gate and empty or illegal notes produce no events", () => {
  assert.equal(renderArp([60], { ...straight, gate: 0, rate: 4, length: 1 }).events.length, 0);
  assert.equal(renderArp([], { ...straight, length: 1 }).events.length, 0);
  assert.equal(renderArp([200, -3, 60.2], { ...straight, rate: 1, length: 1 }).events[0].note, 60);
});

test("chord regions do not leak into each other", () => {
  const result = renderArp(
    [
      { notes: [60], start: 0, length: 1 },
      { notes: [], start: 1, length: 1 },
      { notes: [72, 70], start: 2, length: 1 },
    ],
    { ...straight, mode: "as-played", rate: 1, gate: 1, length: 4 },
  );
  assert.deepEqual(
    result.events.map((event) => [event.note, event.start, event.chordIndex]),
    [
      [60, 0, 0],
      [72, 2, 2],
    ],
  );
});

test("random mode is deterministic for a seed and changes with it", () => {
  const params = { ...straight, mode: "random", rate: 4, length: 2, seed: 42, octaves: 2 };
  const first = notesOf(renderArp([60, 63, 67], params));
  const second = notesOf(renderArp([60, 63, 67], params));
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  const other = notesOf(renderArp([60, 63, 67], { ...params, seed: 7 }));
  assert.notDeepEqual(first, other);
  assert.ok(first.every((note) => note >= 60 && note <= 79));
});

test("unknown mode falls back to up, and a bare midi number is a chord", () => {
  assert.ok(ARP_MODES.includes("as-played"));
  const viaMode = renderArp([64, 60], { ...straight, mode: "sideways", rate: 2, length: 1 });
  assert.deepEqual(notesOf(viaMode), [60, 64]);
  const single = renderArp(72, { ...straight, rate: 1, length: 2 });
  assert.deepEqual(notesOf(single), [72, 72]);
});

test("sequential chord arrays share the fallback length", () => {
  const result = renderArp(
    [
      [60, 64],
      [62, 65],
    ],
    { ...straight, mode: "chord", rate: 1, gate: 1, length: 1 },
  );
  const firstBeat = result.events.filter((event) => event.start < 0.5).map((event) => event.note);
  const secondBeat = result.events.filter((event) => event.start >= 1).map((event) => event.note);
  assert.deepEqual(firstBeat.sort((a, b) => a - b), [60, 64]);
  assert.deepEqual(secondBeat.sort((a, b) => a - b), [62, 65]);
});
