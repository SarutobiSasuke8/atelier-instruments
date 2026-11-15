// Offline tests for the chipbreak pack. Run: node --test tracks/chipbreak/test/
// Recipe, chop-token, measurement and sidecar tests need nothing else. The render tests need a checkout of
// atelier-dsp (ATELIER_DSP, or ../atelier-dsp) and are skipped with a message when it is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from '../arranger.mjs';
import * as M from '../measure.mjs';
import { buildMeta, checkMeta } from '../sidecar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ids = A.recipeIds();
const noDsp = A.dspAvailable() ? false : 'atelier-dsp not found: set ATELIER_DSP to a checkout of SarutobiSasuke8/atelier-dsp';

test('there is exactly one recipe per sub-style', () => {
  assert.deepEqual(ids, Object.keys(A.STYLES).sort());
  assert.equal(ids.length, 8);
});

for (const id of ids) {
  test(`recipe ${id} validates`, () => {
    const r = A.loadRecipe(id);
    assert.deepEqual(A.validateRecipe(r, { fileId: id }), []);
    const tl = A.timeline(r);
    assert.ok(tl.seconds >= 90 && tl.seconds <= 180, `${id} is ${tl.seconds} s`);
    const [lo, hi] = A.STYLES[id].bpm;
    assert.ok(r.bpm >= lo && r.bpm <= hi);
    assert.ok(Number.isInteger(r.seed));
  });
}

test('validation rejects bad recipes with a reason', () => {
  const good = A.loadRecipe('chip-breakcore');
  const clone = () => JSON.parse(JSON.stringify(good));
  const problems = (mutate) => { const r = clone(); mutate(r); return A.validateRecipe(r); };
  assert.ok(problems(r => { r.bpm = 120; }).some(p => /outside/.test(p)));
  assert.ok(problems(r => { r.format = 'x'; }).some(p => /format/.test(p)));
  assert.ok(problems(r => { r.chops.a = '0 1 2'; }).some(p => /16 tokens/.test(p)));
  assert.ok(problems(r => { r.chops.a = '0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 99'; }).some(p => /out of range/.test(p)));
  assert.ok(problems(r => { r.sections.forEach(s => delete s.riser); }).some(p => /riser/.test(p)));
  assert.ok(problems(r => { r.sections = r.sections.filter(s => s.role !== 'breakdown'); }).some(p => /breakdown/.test(p)));
  assert.ok(problems(r => { r.sections.forEach(s => delete s.dist); }).some(p => /distortion/.test(p)));
  assert.ok(problems(r => { r.sections[2].drums.patterns = ['nope']; }).some(p => /unknown chop pattern/.test(p)));
  assert.ok(problems(r => { r.sections[2].tape[0].gestures[0].type = 'melt'; }).some(p => /tape gesture/.test(p)));
  assert.ok(problems(r => { r.sections.splice(1, 6); }).some(p => /must be 90-180/.test(p)));
  assert.ok(problems(r => { r.master = { targetLufs: -6 }; }).some(p => /targetLufs/.test(p)));
});

test('chop tokens parse', () => {
  assert.deepEqual(A.parseChopToken('.'), { rest: true });
  assert.deepEqual(A.parseChopToken('7'), { rest: false, index: 7, reverse: false, rate: 1, stutterDiv: 1 });
  assert.equal(A.parseChopToken('12r').reverse, true);
  assert.equal(A.parseChopToken('12rr').reverse, false);
  assert.equal(A.parseChopToken('3^').rate, 1.5);
  assert.ok(Math.abs(A.parseChopToken('3^^').rate - 2.25) < 1e-9);
  assert.ok(Math.abs(A.parseChopToken('3v').rate - 0.66) < 1e-9);
  assert.equal(A.parseChopToken('3^^^^^').rate, 4, 'pitch rate is capped at 4');
  assert.equal(A.parseChopToken('3*').stutterDiv, 2);
  assert.equal(A.parseChopToken('3**').stutterDiv, 4);
  assert.equal(A.parseChopToken('3*****').stutterDiv, 8, 'stutter division is capped at 8');
  const mixed = A.parseChopToken('15r^*');
  assert.deepEqual([mixed.index, mixed.reverse, mixed.rate, mixed.stutterDiv], [15, true, 1.5, 2]);
  for (const bad of ['16', 'x', '3x', '-1', '', '3 ^', '^3']) assert.throws(() => A.parseChopToken(bad), RangeError, bad);
});

test('chop patterns need exactly 16 tokens and every recipe pattern parses', () => {
  assert.equal(A.parseChopPattern('0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15').length, 16);
  assert.throws(() => A.parseChopPattern('0 1 2'), /16 tokens/);
  assert.throws(() => A.parseChopPattern(Array(17).fill('0').join(' ')), /16 tokens/);
  for (const id of ids) for (const [name, p] of Object.entries(A.loadRecipe(id).chops)) assert.equal(A.parseChopPattern(p).length, 16, `${id}.${name}`);
});

test('every recipe uses stutters or pitch rolls in its chop sets (the chopped-break signature)', () => {
  for (const id of ids) {
    const all = Object.values(A.loadRecipe(id).chops).join(' ');
    assert.ok(/\*/.test(all) || /\^/.test(all), id);
  }
});

test('loudness meter reads a calibration tone', () => {
  const fs = 44100, n = fs * 5, tone = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 997 * i / fs) * 10 ** (-23 / 20));
  const lufs = M.integratedLufs([tone, tone], fs);
  assert.ok(Math.abs(lufs - -23) < 0.25, `got ${lufs}`);
});

test('true-peak meter sees an inter-sample over that the sample peak misses', () => {
  const fs = 44100, n = 4096;
  // a tone at fs/4 with 45 degrees of phase: every sample sits at 0.707 of the real peak
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin(Math.PI / 2 * i + Math.PI / 4) * 0.9);
  assert.ok(M.samplePeak([x]) < 0.9 * 0.72);
  assert.ok(M.truePeak([x]) > 0.86, `true peak ${M.truePeak([x])}`);
});

test('flat-top, silence and non-finite detectors', () => {
  const clipped = new Float32Array(2000); for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-0.5, Math.min(0.5, Math.sin(i / 20) * 2));
  assert.ok(M.flatTopRuns([clipped, clipped]) > 0);
  const smooth = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 20) * 0.5);
  assert.equal(M.flatTopRuns([smooth, smooth]), 0);
  const quiet = new Float32Array(44100 * 2), loud = Float32Array.from({ length: 44100 * 2 }, (_, i) => Math.sin(i / 9) * 0.3);
  quiet.set(loud.subarray(0, 44100)); // first second loud, second second silent
  assert.deepEqual(M.silentBars([quiet, quiet], 44100, 2), [1]);
  assert.equal(M.countNonFinite([Float32Array.of(0, NaN, Infinity, 1)]), 2);
});

test('committed sidecars are lmms-mcp-meta/1 and carry the measured figures', { skip: !existsSync(join(ROOT, 'meta')) && 'no sidecars yet' }, () => {
  for (const id of ids) {
    const meta = JSON.parse(readFileSync(join(ROOT, 'meta', `${id}.meta.json`), 'utf8'));
    const stats = JSON.parse(readFileSync(join(ROOT, 'meta', `${id}.stats.json`), 'utf8'));
    assert.deepEqual(checkMeta(meta), [], id);
    assert.equal(meta.kind, 'piece');
    assert.equal(stats.kind, 'track');
    assert.equal(stats.id, id);
    assert.ok(stats.peakDbfs <= -1 && stats.truePeakDbtp <= -1, `${id} wav ceiling`);
    assert.ok(stats.mp3.samplePeakDbfs <= -1 && stats.mp3.truePeakDbtp <= -1, `${id} mp3 ceiling`);
    assert.ok(stats.lufs >= -12 && stats.lufs <= -9, `${id} loudness ${stats.lufs}`);
    assert.ok(Number.isFinite(stats.lra));
    assert.ok(stats.durationSec >= 90 && stats.durationSec <= 180);
    assert.equal(stats.analysis.nonFinite, 0);
    assert.equal(stats.analysis.flatTopRuns, 0);
    assert.deepEqual(stats.analysis.silentBars, []);
    assert.equal(meta.licence, 'MIT (own work)');
    assert.ok(stats.engines.every(e => /^[\w-]+@[0-9a-f]{7}$/.test(e)), 'engines are repo@sha');
  }
});

test('buildMeta produces a valid sidecar', () => {
  const r = A.loadRecipe('chip-breakcore');
  const m = buildMeta(r, { durationSec: 101, peakDbfs: -1.9, truePeakDbtp: -1.5, lufs: -10.5, lra: 7 });
  assert.deepEqual(checkMeta(m), []);
  assert.ok(checkMeta({ ...m, bpm: 190 }).some(p => /unknown/.test(p)));
});

test('licences.json lists no third-party audio', () => {
  const l = JSON.parse(readFileSync(join(ROOT, 'licences.json'), 'utf8'));
  assert.deepEqual(l.thirdPartyAudio, []);
});

// ---------- renders (need atelier-dsp) ----------
const PREVIEW_BARS = 8;
const renderPreview = async (id, opts = {}) => {
  const r = A.loadRecipe(id), res = await A.renderTrack(A.previewRecipe(r, PREVIEW_BARS), { skipValidation: true, loudnessIterations: 1, ...opts });
  return res;
};
const hash = chans => { const h = createHash('sha256'); for (const c of chans) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength)); return h.digest('hex'); };

for (const id of ids) {
  test(`8-bar ${id} render is finite, audible and under the ceiling`, { skip: noDsp, timeout: 120000 }, async () => {
    const res = await renderPreview(id);
    const q = M.quantise16(res.channels);
    assert.equal(res.channels[0].length, res.totalFrames);
    assert.equal(M.countNonFinite(res.channels), 0, 'NaN or Infinity in the render');
    assert.ok(M.samplePeak(q) > 0.05, 'render is silent');
    assert.deepEqual(M.silentBars(q, Math.round(res.timeline.bar * A.SR), PREVIEW_BARS), [], 'a silent bar');
    assert.ok(M.db(M.samplePeak(q)) <= -1, `sample peak ${M.db(M.samplePeak(q))} dBFS`);
    assert.ok(M.db(M.truePeak(q)) <= -1, `true peak ${M.db(M.truePeak(q))} dBTP`);
    assert.equal(M.flatTopRuns(q), 0, 'flat-topped (clipped) run');
  });
}

for (const id of ['chip-breakcore', 'halftime-chip-dubstep']) {
  test(`8-bar ${id} render is deterministic for a seed and changes with another`, { skip: noDsp, timeout: 240000 }, async () => {
    const a = await renderPreview(id), b = await renderPreview(id);
    assert.equal(hash(a.channels), hash(b.channels), 'same seed, different audio');
    const r = A.loadRecipe(id), other = await A.renderTrack(A.previewRecipe({ ...r, seed: r.seed + 1 }, PREVIEW_BARS), { skipValidation: true, loudnessIterations: 1 });
    assert.notEqual(hash(a.channels), hash(other.channels), 'seed has no effect');
  });
}

test('no audio file in the tree is over 1 MB', () => {
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'out' ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
  for (const f of walk(ROOT)) if (/\.(wav|mp3|ogg|flac)$/i.test(f)) assert.fail(`audio committed in ${f}`);
});
