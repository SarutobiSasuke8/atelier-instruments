// Chipbreak arranger: turns one recipe (tracks/chipbreak/recipes/<id>.json) into a mastered stereo track.
// Everything is synthesised. The sound comes from atelier-dsp (groovebox pad voices, wavetable and chiptune
// renderers, formant, saturation, compressor) and from the atelier-instruments engines in apps/ (tape-glitch,
// game-sfx, trailer-riser, acid-bass). There are no samples and no third-party audio.
//
// atelier-dsp is not vendored. Point ATELIER_DSP at a checkout of SarutobiSasuke8/atelier-dsp (main), or put the
// checkout beside this repo as ../atelier-dsp. Recipe validation, chop-token parsing and the measurement code need no
// engines, so those parts of the test suite run anywhere.
//
// This module grew out of a single-track demo script. The break source, chop tokens, tape-edit windows, distortion bus
// and two-pass true-peak limiter are the same ideas, now driven by data.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as M from './measure.mjs';

export const SR = 44100;
export const FORMAT = 'chipbreak-recipe/1';
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const RECIPE_DIR = join(HERE, 'recipes');

export const STYLES = {
  'chip-breakcore': { bpm: [180, 200] },
  'tape-warped-jungle': { bpm: [165, 172] },
  'glitch-hop-chip': { bpm: [95, 110] },
  'nightcore-speed-chip-rave': { bpm: [170, 180] },
  'distorted-8bit-dnb': { bpm: [172, 175] },
  'lofi-tape-chip-breaks': { bpm: [80, 92] },
  'gabber-chip': { bpm: [180, 200] },
  'halftime-chip-dubstep': { bpm: [140, 140] },
};
export const ROLES = ['intro', 'build', 'drop', 'breakdown', 'outro'];
export const BASS_ENGINES = ['none', 'reese', 'reese-sat', 'acid', 'sq1bit', 'sub', 'growl'];
export const GESTURES = ['wow', 'flutter', 'stop', 'start', 'stutter', 'reverse', 'crush', 'dropout'];
export const SFX_IDS = ['jump', 'coin', 'power-up', 'laser', 'explosion', 'hit', 'pickup', 'menu-click', 'error', 'level-up', 'footstep'];
export const VOX_PRESETS = ['choir-pad', 'ooh-stab', 'talkbox-lead', 'robot-stab'];
export const DIST_BUSES = ['drums', 'bass', 'chip', 'vox', 'sfx', 'fxr'];
export const BUSES = ['drums', 'bass', 'chip', 'vox', 'sfx', 'fxr'];
export const MIN_SECONDS = 90, MAX_SECONDS = 180;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mod = (n, m) => ((n % m) + m) % m;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- chop tokens ----------
// A pattern is 16 tokens, one bar of 16th steps. A token is a slice number 0-15 followed by modifiers:
//   r  reverse the slice            ^  pitch up (x1.5 per mark)       v  pitch down (x0.66 per mark)
//   *  stutter: loop the first half of the slice (each extra * halves it again, up to 1/8)
//   .  alone: rest
export function parseChopToken(token) {
  const t = String(token);
  if (t === '.') return { rest: true };
  const m = /^(\d{1,2})([rv^*]*)$/.exec(t);
  if (!m) throw new RangeError(`Bad chop token "${t}"`);
  const index = Number(m[1]);
  if (index > 15) throw new RangeError(`Chop slice ${index} is out of range 0-15`);
  const count = ch => m[2].split(ch).length - 1;
  return { rest: false, index, reverse: count('r') % 2 === 1, rate: clamp(1.5 ** count('^') * 0.66 ** count('v'), 0.25, 4), stutterDiv: 2 ** Math.min(count('*'), 3) };
}
export function parseChopPattern(pattern) {
  const tokens = String(pattern).trim().split(/\s+/);
  if (tokens.length !== 16) throw new RangeError(`A chop pattern needs 16 tokens, got ${tokens.length}`);
  return tokens.map(parseChopToken);
}

// ---------- recipes ----------
export function loadRecipe(id, dir = RECIPE_DIR) { return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')); }
export function recipeIds(dir = RECIPE_DIR) { return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => basename(f, '.json')).sort(); }

export function timeline(recipe) {
  const beat = 60 / recipe.bpm, bar = beat * 4;
  let at = 0;
  const sections = recipe.sections.map((s, index) => { const o = { ...s, index, from: at, to: at + s.bars }; at += s.bars; return o; });
  return { bpm: recipe.bpm, beat, step: beat / 4, bar, bars: at, seconds: at * bar, sections };
}

// Returns a list of problems. An empty list means the recipe is valid.
export function validateRecipe(r, { fileId } = {}) {
  const e = [];
  const bad = msg => e.push(msg);
  const num = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
  if (!r || typeof r !== 'object') return ['recipe must be an object'];
  if (r.format !== FORMAT) bad(`format must be "${FORMAT}"`);
  if (typeof r.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)) bad('id must be lower-case words joined by hyphens');
  if (fileId && r.id !== fileId) bad(`id "${r.id}" does not match the file name "${fileId}"`);
  if (typeof r.title !== 'string' || !r.title.trim() || r.title.length > 120) bad('title is required (up to 120 characters)');
  if (!Object.hasOwn(STYLES, r.style)) bad(`style must be one of ${Object.keys(STYLES).join(', ')}`);
  else if (r.id !== r.style) bad('id must equal style so each sub-style has exactly one track');
  if (!Array.isArray(r.genre) || !r.genre.length) bad('genre must be a non-empty list');
  if (!Array.isArray(r.mood) || !r.mood.length) bad('mood must be a non-empty list');
  if (typeof r.key !== 'string' || !r.key) bad('key text is required, for example "A minor"');
  if (!Number.isInteger(r.tonic) || r.tonic < 24 || r.tonic > 48) bad('tonic must be a MIDI note from 24 to 48');
  if (!['minor', 'major'].includes(r.scale)) bad('scale must be minor or major');
  if (!Number.isInteger(r.seed) || r.seed < 0) bad('seed must be a non-negative integer');
  const range = STYLES[r.style]?.bpm;
  if (!num(r.bpm, 40, 260)) bad('bpm must be a number');
  else if (range && (r.bpm < range[0] || r.bpm > range[1])) bad(`bpm ${r.bpm} is outside ${r.style} range ${range[0]}-${range[1]}`);
  if (!Array.isArray(r.progression) || !r.progression.length || !r.progression.every(p => p && Number.isInteger(p.deg) && ['min', 'maj'].includes(p.q))) bad('progression must be a list of { deg, q: "min"|"maj" }');

  // kit, break and chops
  const kit = r.kit && typeof r.kit === 'object' ? r.kit : (bad('kit is required'), {});
  for (const name of ['kick', 'snare', 'hat']) if (!kit[name]) bad(`kit.${name} is required`);
  for (const [name, spec] of Object.entries(kit)) if (!spec || typeof spec.voice !== 'string') bad(`kit.${name} needs a voice`);
  const brk = r.break;
  if (!brk || typeof brk.pattern !== 'object') bad('break.pattern is required');
  else {
    for (const [step, hits] of Object.entries(brk.pattern)) {
      if (!/^\d+$/.test(step) || +step > 15) bad(`break.pattern step "${step}" must be 0-15`);
      if (!Array.isArray(hits) || !hits.every(h => Array.isArray(h) && kit[h[0]] && num(h[1], 0, 2))) bad(`break.pattern step ${step} must list [kitName, gain] pairs from the kit`);
    }
    if (brk.swing !== undefined && !num(brk.swing, 0, 0.45)) bad('break.swing must be 0-0.45');
  }
  const chops = r.chops && typeof r.chops === 'object' ? r.chops : (bad('chops is required'), {});
  for (const [name, p] of Object.entries(chops)) { try { parseChopPattern(p); } catch (x) { bad(`chops.${name}: ${x.message}`); } }

  // sections
  let seconds = 0;
  const names = new Set();
  if (!Array.isArray(r.sections) || !r.sections.length) bad('sections must be a non-empty list');
  else {
    let bars = 0;
    for (const s of r.sections) {
      if (!s || typeof s.name !== 'string') { bad('every section needs a name'); continue; }
      if (names.has(s.name)) bad(`duplicate section name "${s.name}"`);
      names.add(s.name);
      if (!ROLES.includes(s.role)) bad(`section ${s.name}: role must be one of ${ROLES.join(', ')}`);
      if (!Number.isInteger(s.bars) || s.bars < 1 || s.bars > 64) bad(`section ${s.name}: bars must be an integer 1-64`);
      else bars += s.bars;
      const d = s.drums;
      if (d) {
        if (!['chops', 'halftime', 'none'].includes(d.mode ?? 'chops')) bad(`section ${s.name}: drums.mode must be chops, halftime or none`);
        for (const p of [...(d.patterns ?? []), ...(d.roll ? [d.roll] : [])]) if (!Object.hasOwn(chops, p)) bad(`section ${s.name}: unknown chop pattern "${p}"`);
        if ((d.mode ?? 'chops') === 'chops' && !(d.patterns && d.patterns.length)) bad(`section ${s.name}: drums.patterns is required for chops`);
      }
      for (const bb of [].concat(s.bass ?? [])) {
        if (!BASS_ENGINES.includes(bb.engine)) bad(`section ${s.name}: bass.engine must be one of ${BASS_ENGINES.join(', ')}`);
        else if (bb.engine !== 'none' && bb.engine !== 'acid' && !(r.bass?.patterns && r.bass.patterns[bb.pattern])) bad(`section ${s.name}: unknown bass pattern "${bb.pattern}"`);
        if (bb.engine === 'acid' && !r.bass?.acid?.preset) bad(`section ${s.name}: bass.acid.preset is required for the acid engine`);
      }
      if (s.rave && !r.rave?.patterns?.[s.rave.pattern]) bad(`section ${s.name}: unknown rave stab pattern "${s.rave.pattern}"`);
      for (const h of s.sfx ?? []) if (!Array.isArray(h) || !Number.isInteger(h[0]) || h[0] < 0 || h[0] >= s.bars || !num(h[1], 0, 3.99) || !SFX_IDS.includes(h[2])) bad(`section ${s.name}: bad sfx hit ${JSON.stringify(h)}`);
      for (const [bus, o] of Object.entries(s.dist ?? {})) {
        if (!DIST_BUSES.includes(bus)) bad(`section ${s.name}: unknown distortion bus "${bus}"`);
        else if (!(Number.isInteger(o.bits) && o.bits >= 2 && o.bits <= 16 && Number.isInteger(o.hold) && o.hold >= 1 && num(o.drive, 0, 12) && num(o.mix, 0, 1))) bad(`section ${s.name}: dist.${bus} needs bits 2-16, hold >= 1, drive 0-12, mix 0-1`);
      }
      for (const t of s.tape ?? []) {
        if (!Number.isInteger(t.bar) || t.bar < 0 || !Number.isInteger(t.bars) || t.bars < 1 || t.bar + t.bars > s.bars + 1) bad(`section ${s.name}: tape window ${JSON.stringify([t.bar, t.bars])} does not fit (it may run one bar into the next section)`);
        if (!Array.isArray(t.gestures) || !t.gestures.length) bad(`section ${s.name}: tape window needs gestures`);
        for (const g of t.gestures ?? []) if (!GESTURES.includes(g.type) || !num(g.t0, 0, 1) || !num(g.t1, 0, 1) || g.t1 <= g.t0) bad(`section ${s.name}: bad tape gesture ${JSON.stringify(g)}`);
      }
      const v = s.vox;
      if (v) {
        if (v.stab && !r.vox?.stab?.patterns) bad(`section ${s.name}: vox.stab used but recipe.vox.stab.patterns is missing`);
        if (v.stab) for (const p of String(v.stab).split(',')) if (!r.vox?.stab?.patterns?.[p]) bad(`section ${s.name}: unknown vox stab pattern "${p}"`);
        if (v.pad && !VOX_PRESETS.includes(v.pad)) bad(`section ${s.name}: vox.pad must be one of ${VOX_PRESETS.join(', ')}`);
      }
      const c = s.chip;
      if (c?.lead) for (const p of [].concat(c.lead)) if (!r.chip?.lead?.phrases?.[p]) bad(`section ${s.name}: unknown lead phrase "${p}"`);
    }
    seconds = bars * (60 / r.bpm) * 4;
    if (num(r.bpm, 40, 260) && (seconds < MIN_SECONDS || seconds > MAX_SECONDS)) bad(`track is ${seconds.toFixed(1)} s; it must be ${MIN_SECONDS}-${MAX_SECONDS} s`);
  }
  if (r.vox?.stab) { if (!VOX_PRESETS.includes(r.vox.stab.preset)) bad('vox.stab.preset is not a formant preset'); if (!Array.isArray(r.vox.stab.midis) || !r.vox.stab.midis.length) bad('vox.stab.midis is required'); }

  // required elements from the brief
  const secs = Array.isArray(r.sections) ? r.sections.filter(s => s && typeof s === 'object') : [];
  if (!secs.some(s => num(s.chip?.arp, 0.01, 2) || s.ratchet)) bad('needs a chip-arp section (chip.arp > 0)');
  if (!secs.some(s => s.riser)) bad('needs a riser build (a section with riser)');
  if (!secs.some(s => s.role === 'drop' && s.drums && s.drums.patterns?.length >= 2)) bad('needs a drop with at least two chop patterns');
  if (!secs.some(s => s.tape?.some(t => t.gestures.some(g => g.type === 'stop' || g.type === 'stutter')) || Object.values(chops).some(p => /\*/.test(p)))) bad('needs a tape-stop or stutter edit');
  if (!secs.some(s => s.dist && Object.keys(s.dist).length)) bad('needs a distortion or bitcrush bus (a section with dist)');
  if (!secs.some(s => s.role === 'breakdown')) bad('needs a breakdown or contrast section');
  if (r.master && r.master.targetLufs !== undefined && !num(r.master.targetLufs, -12, -9)) bad('master.targetLufs must be -12 to -9');
  return e;
}
export function assertRecipe(r, opts) { const e = validateRecipe(r, opts); if (e.length) throw new Error(`Invalid recipe ${r?.id ?? ''}:\n - ${e.join('\n - ')}`); return r; }

// ---------- engines ----------
export function resolveDspRoot(env = process.env) {
  const candidates = [env.ATELIER_DSP, resolve(REPO, '..', 'atelier-dsp')].filter(Boolean);
  return candidates.find(c => existsSync(join(c, 'src', 'groovebox', 'index.js'))) ?? null;
}
export function dspAvailable() { return resolveDspRoot() !== null; }
const url = p => pathToFileURL(p).href;
let engineCache = null;
export async function loadEngines({ dsp = resolveDspRoot(), repo = REPO } = {}) {
  if (!dsp) throw new Error('atelier-dsp not found. Set ATELIER_DSP to a checkout of SarutobiSasuke8/atelier-dsp (main), or place it at ../atelier-dsp.');
  if (engineCache?.dsp === dsp) return engineCache;
  const d = f => import(url(join(dsp, 'src', f)));
  const a = (app, f = 'engine.js') => import(url(join(repo, 'apps', app, f)));
  engineCache = {
    dsp, repo,
    G: await d('groovebox/index.js'), WC: await d('instruments/wavetable-chip/index.js'), TX: await d('instruments/textures/index.js'), FX: await d('dsp/index.js'),
    TAPE: await a('tape-glitch'), SFX: await a('game-sfx'), TRAILER: await a('trailer-riser'), ACID: await a('acid-bass'),
  };
  return engineCache;
}
export function gitSha(dir) {
  try {
    const head = readFileSync(join(dir, '.git'), 'utf8').trim();
    const gitDir = head.startsWith('gitdir:') ? resolve(dir, head.slice(7).trim()) : join(dir, '.git');
    const ref = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!ref.startsWith('ref:')) return ref.slice(0, 7);
    const name = ref.slice(5);
    for (const base of [gitDir, join(gitDir, '..', '..')]) { const f = join(base, name); if (existsSync(f)) return readFileSync(f, 'utf8').trim().slice(0, 7); }
    const packed = readFileSync(join(existsSync(join(gitDir, 'packed-refs')) ? gitDir : join(gitDir, '..', '..'), 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(' ' + name));
    return packed ? packed.slice(0, 7) : 'unknown';
  } catch { try { const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim(); return head.startsWith('ref:') ? readFileSync(join(dir, '.git', head.slice(5)), 'utf8').trim().slice(0, 7) : head.slice(0, 7); } catch { return 'unknown'; } }
}

// ---------- small DSP helpers ----------
function lr(src) {
  if (src && src.left) return [src.left, src.right ?? src.left];
  if (src && src.channels) return [src.channels[0], src.channels[1] ?? src.channels[0]];
  if (Array.isArray(src) && src.length === 2 && typeof src[0] !== 'number') return src;
  return [src, src];
}
function resample(buf, rate) {
  const n = Math.floor((buf.length - 1) / rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * rate, k = Math.floor(p); out[i] = buf[k] + (buf[k + 1] - buf[k]) * (p - k); }
  return out;
}
function onePoleLow(buf, hz) { const k = 1 - Math.exp(-2 * Math.PI * hz / SR); let y = 0; const o = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) { y += (buf[i] - y) * k; o[i] = y; } return o; }
function biquadLow(x, hz, q) {
  const w = 2 * Math.PI * hz / SR, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const xi = x[i], y = b0 * xi + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = y; x[i] = y; }
}

// ---------- the render ----------
export async function renderTrack(recipe, opts = {}) {
  if (!opts.skipValidation) assertRecipe(recipe); // previews are cut from a recipe that has already been validated
  const E = opts.engines ?? await loadEngines();
  const { G, WC, TX, FX, TAPE, SFX, TRAILER, ACID } = E;
  const log = opts.log ?? (() => {});
  const tl = timeline(recipe);
  const { bpm, beat: BEAT, step: STEP, bar: BAR } = tl;
  const TOTAL = Math.ceil((tl.bars * BAR + 1.5) * SR);
  const BAR_F = Math.round(BAR * SR), STEP_F = Math.round(STEP * SR);
  const barT = b => b * BAR;
  const seed = recipe.seed;
  const stereo = () => [new Float32Array(TOTAL), new Float32Array(TOTAL)];
  const bus = Object.fromEntries(BUSES.map(b => [b, stereo()]));
  function add(dst, src, t, gain = 1, pan = 0) {
    const [L, R] = lr(src);
    const o = Math.round(t * SR), gl = gain * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = gain * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    for (let i = 0; i < L.length && o + i < TOTAL; i++) { if (o + i < 0) continue; dst[0][o + i] += L[i] * gl; dst[1][o + i] += R[i] * gr; }
  }
  const norm = (buf, to = 1) => { let p = 1e-9; for (const v of buf) p = Math.max(p, Math.abs(v)); const k = to / p; return buf.map(v => v * k); };

  // harmony: one chord per bar
  const chordAt = bar => {
    const p = recipe.progression[bar % recipe.progression.length], base = recipe.tonic + p.deg;
    const root = 48 + mod(base - 48, 12);
    return { notes: [root, root + (p.q === 'min' ? 3 : 4), root + 7], minor: p.q === 'min', bassRoot: 28 + mod(base - 28, 12) };
  };

  // 1. source break: one original bar built from groovebox pad voices, pre-driven, sliced in 16
  const hits = {};
  for (const [name, spec] of Object.entries(recipe.kit)) {
    const pad = { type: 'drum', voice: spec.voice, character: spec.character ?? '909', decay: spec.decay ?? 0.2, tone: spec.tone ?? 0.5, drive: spec.drive ?? 0.35, tune: spec.tune ?? 0, level: spec.level ?? 0.9 };
    let h = Float32Array.from(G.renderPad(pad, { sampleRate: SR, velocity: spec.vel ?? 1, rootMidi: 38, seed: spec.seed ?? 1 }));
    if (spec.post) { const k = spec.post.sat ?? 1, lv = spec.post.level ?? 1; for (let i = 0; i < h.length; i++) h[i] = FX.saturate(h[i], spec.post.mode ?? 'tanh', k) * lv; }
    hits[name] = h;
  }
  const swing = recipe.break.swing ?? 0;
  const breakBar = new Float32Array(BAR_F + STEP_F * 8 + SR);
  for (const [st, list] of Object.entries(recipe.break.pattern)) for (const [name, g] of list) {
    const h = hits[name], o = +st * STEP_F + (+st % 2 ? Math.round(swing * STEP_F) : 0);
    for (let i = 0; i < h.length && o + i < breakBar.length; i++) breakBar[o + i] += h[i] * g;
  }
  let src = breakBar.map(v => FX.saturate(v * 1.3, 'tube', recipe.break.preDrive ?? 1.6));
  if (recipe.break.crush) { const q = 2 ** (recipe.break.crush.bits - 1), hold = recipe.break.crush.hold ?? 1; let held = 0; src = src.map((v, i) => { if (i % hold === 0) held = Math.round(v * q) / q; return held; }); }
  if (recipe.break.lowpassHz) src = onePoleLow(onePoleLow(src, recipe.break.lowpassHz), recipe.break.lowpassHz);
  const slices = Array.from({ length: 16 }, (_, i) => src.slice(i * STEP_F, i * STEP_F + STEP_F * 4));
  const parsedChops = Object.fromEntries(Object.entries(recipe.chops).map(([k, v]) => [k, parseChopPattern(v)]));
  function chopSlice(tok) {
    if (tok.rest) return null;
    const len = Math.max(1, Math.round(STEP_F / tok.stutterDiv)), s = slices[tok.index], out = new Float32Array(STEP_F);
    for (let i = 0; i < STEP_F; i++) {
      const j = i % len, p = j * tok.rate, k = Math.floor(p);
      if (k + 1 >= s.length) break;
      const v = s[k] + (s[k + 1] - s[k]) * (p - k);
      out[i] = v * Math.min(1, (len - j) / 60) * Math.min(1, j / 20);
    }
    return tok.reverse ? out.reverse() : out;
  }
  const playChop = (bar, name, gain) => parsedChops[name].forEach((tok, s) => { const sl = chopSlice(tok); if (sl) add(bus.drums, sl, barT(bar) + s * STEP + (s % 2 ? swing * STEP : 0), gain); });
  function halfTimeBar(bar, gain) {
    add(bus.drums, hits.kick, barT(bar), gain); add(bus.drums, hits.snare, barT(bar) + 2 * BEAT, gain);
    for (let s = 0; s < 16; s += 2) add(bus.drums, hits.hat, barT(bar) + s * STEP, gain * 0.5, s % 4 ? 0.3 : -0.3);
    if (bar % 2) { add(bus.drums, chopSlice(parseChopToken('7v')), barT(bar) + 3.5 * BEAT, gain * 0.7); add(bus.drums, hits.ghost ?? hits.hat, barT(bar) + 3.75 * BEAT, gain * 0.7); }
  }
  const lerp = (g, i, n) => Array.isArray(g) ? g[0] + (g[1] - g[0]) * (n > 1 ? i / (n - 1) : 0) : g;

  // caches for repeated notes
  const noteCache = new Map();
  const cached = (key, make) => { if (!noteCache.has(key)) noteCache.set(key, make()); return noteCache.get(key); };
  const wt = (o, key) => cached(`wt|${key}`, () => WC.renderWavetable({ sampleRate: SR, bpm, velocity: 1, ...o }));
  const formant = (preset, midi, seconds, sd, level = 0.8) => cached(`fm|${preset}|${midi}|${seconds.toFixed(4)}|${sd}`, () => TX.renderFormant({ preset, midi, seconds, sampleRate: SR, seed: sd, level }));
  const acidCache = { acid: new Map() };

  for (const sec of tl.sections) {
    const { from, to, bars } = sec, rel = b => b - from, t0 = barT(from);
    log(`section ${sec.name} bars ${from}-${to}`);

    // 2. drums
    const d = sec.drums;
    if (d && (d.mode ?? 'chops') !== 'none') for (let bar = from; bar < to; bar++) {
      const i = rel(bar);
      if (i < (d.from ?? 0) || i >= bars - (d.until ?? 0)) continue;
      const g = lerp(d.gain ?? 1, i, bars);
      if (d.mode === 'halftime') halfTimeBar(bar, g);
      else playChop(bar, d.roll && i >= bars - (d.rollBars ?? 0) ? d.roll : d.patterns[i % d.patterns.length], g);
    }
    if (sec.kick4) {
      const every = sec.kick4.everySteps ?? 4;
      for (let bar = from + (sec.kick4.from ?? 0); bar < to; bar++) for (let s = 0; s < 16; s += every) add(bus.drums, hits.kick, barT(bar) + s * STEP, sec.kick4.gain ?? 0.8);
    }

    // 3. chip lanes: one renderChiptune per section
    const c = sec.chip, rc = recipe.chip ?? {}, chipNotes = [], rt = b => b * BAR;
    if (c) {
      for (let bar = from; bar < to; bar++) {
        const ch = chordAt(bar), arpSet = ch.minor ? rc.arp.minor : rc.arp.major, i = rel(bar);
        if (c.arp > 0) {
          if ((c.arpMode ?? 'stab') === 'slow') for (let b = 0; b < 4; b += 2) chipNotes.push({ preset: 'arpeggio-stab', midi: ch.notes[0] + (c.arpOctave ?? rc.arp.octave ?? 12) - 12, start: rt(i) + b * BEAT, duration: BEAT * 1.9, channel: 0, velocity: 0.6 * c.arp, pan: -0.2, patch: { arp: rc.arp.slow ?? [0, 7, 12, 19], arpBeats: (rc.arp.beats ?? 0.125) * 2, release: 0.2 } });
          else for (let b = 0; b < 4; b++) chipNotes.push({ preset: 'arpeggio-stab', midi: ch.notes[0] + (c.arpOctave ?? rc.arp.octave ?? 12), start: rt(i) + b * BEAT, duration: BEAT * 0.95, channel: 0, velocity: clamp(0.9 * c.arp, 0, 1), pan: -0.35, patch: { arp: arpSet, arpBeats: rc.arp.beats ?? 0.125, pulseWidth: c.pulseWidth ?? rc.arp.pulseWidth ?? 0.25 } });
        }
        if (c.hats) for (let s = 0; s < 16; s++) if (c.hats === 'all' || s % 2 === 0) chipNotes.push({ preset: 'noise-hat', midi: 72 + (s % 4 === 2 ? 7 : 0), start: rt(i) + s * STEP, duration: STEP * 0.4, channel: 3, velocity: s % 4 === 2 ? 0.8 : 0.45, pan: 0.4 });
        if (c.tribass && i >= (c.tribass.from ?? 0)) for (let b = 0; b < 4; b++) chipNotes.push({ preset: 'triangle-bass', midi: ch.bassRoot + 12, start: rt(i) + b * BEAT, duration: BEAT * (c.tribass.len ?? 0.5), channel: 2, velocity: 0.9 });
      }
      if (c.lead) {
        const lead = rc.lead, names = [].concat(c.lead), pb = lead.phraseBars ?? 2, legato = c.legato ?? lead.legato ?? 0.85;
        for (let bar = from + (c.leadFrom ?? 0); bar < to; bar += pb) {
          const mel = lead.phrases[names[(Math.floor(rel(bar) / pb)) % names.length]];
          mel.forEach(([st, deg], k) => {
            const nextSt = mel[k + 1]?.[0] ?? pb * 16, start = rt(rel(bar)) + st * STEP;
            if (rel(bar) * 16 + st >= bars * 16) return;
            chipNotes.push({ preset: lead.preset ?? 'pulse-lead', midi: recipe.tonic + 12 + deg + (c.leadOctave ?? lead.octave ?? 0), start, duration: (nextSt - st) * STEP * legato, channel: 1, velocity: 0.85, pan: 0.15, patch: lead.patch ?? { pwm: 0.3, pulseWidth: 0.2 } });
          });
        }
      }
    }
    if (chipNotes.length) add(bus.chip, WC.renderChiptune({ notes: chipNotes, sampleRate: SR, bpm, seed: seed + sec.index * 7 + 11 }), t0, sec.chipGain ?? recipe.chip?.gain ?? 0.55);

    // 3b. ratcheted arp layer (a local equivalent of the arp-lab engine, so no unmerged branch is needed)
    if (sec.ratchet) {
      const rr = sec.ratchet, random = rng(seed + sec.index * 13 + 5), events = [];
      const perBar = 4 * (rr.rate ?? 4), octs = rr.octaves ?? 2;
      for (let bar = from; bar < to; bar++) {
        const ch = chordAt(bar), pool = []; for (let o = 0; o < octs; o++) for (const n of ch.notes) pool.push(n + 12 + 12 * o);
        const order = rr.mode === 'down' ? [...pool].reverse() : rr.mode === 'up' ? pool : [...pool, ...pool.slice(1, -1).reverse()];
        for (let s = 0; s < perBar; s++) {
          if (random() > (rr.probability ?? 1)) continue;
          const n = order[s % order.length], slot = BAR / perBar, parts = (rr.ratchets ?? 1) > 1 && random() < 0.5 ? rr.ratchets : 1;
          for (let p = 0; p < parts; p++) events.push({ midi: n, start: rt(rel(bar)) + s * slot + p * slot / parts, dur: slot / parts * (rr.gate ?? 0.5) });
        }
      }
      const out = new Float32Array(Math.ceil((bars * BAR + 0.5) * SR));
      const dec = rr.decay ?? 0.08, lp = rr.cutoff ?? 3200;
      for (const ev of events) {
        const hz = 440 * 2 ** ((ev.midi - 69) / 12), a = Math.round(ev.start * SR), len = Math.round((ev.dur + 0.05) * SR); let ph = 0;
        for (let i = 0; i < len && a + i < out.length; i++) {
          ph = (ph + hz / SR) % 1; const w = rr.wave === 'saw' ? 2 * ph - 1 : (ph < (rr.pulseWidth ?? 0.5) ? 1 : -1);
          const env = Math.exp(-i / (SR * dec)) * Math.min(1, (len - i) / (0.02 * SR)) * Math.min(1, i / 40);
          out[a + i] += w * env * 0.3;
        }
      }
      add(bus.chip, norm(onePoleLow(out, lp), 0.5), t0, rr.gain ?? 0.6, rr.pan ?? 0.35);
    }

    // 4. bass
    for (const b of [].concat(sec.bass ?? [])) {
      if (b.engine === 'none') continue;
      const rb = recipe.bass ?? {}, pat = rb.patterns?.[b.pattern] ?? [];
      for (let bar = from; bar < to; bar++) {
        const ch = chordAt(bar), i = rel(bar);
        if (i < (b.from ?? 0) || i >= bars - (b.until ?? 0)) continue;
        if (b.engine === 'acid') continue;
        for (const [beat, len, octave = 0] of pat) {
          const midi = ch.bassRoot + 12 + octave - (b.engine === 'sub' || b.engine === 'sq1bit' ? 12 : 0), start = t0 + i * BAR + beat * BEAT, dur = len * BEAT;
          if (b.engine === 'reese' || b.engine === 'reese-sat') {
            let n = wt({ preset: 'reese-bass', midi, duration: dur, gain: rb.reese?.gain ?? 0.8, seed: seed + bar, ...(rb.reese?.patch ?? {}) }, `r|${midi}|${dur.toFixed(4)}|${seed + bar}`);
            if (b.engine === 'reese-sat') n = cached(`rs|${midi}|${dur.toFixed(4)}|${seed + bar}`, () => [n.left, n.right].map(ch2 => { const sat = FX.createSaturator({ mode: 'tube', oversample: 4, drive: rb.reeseSat?.drive ?? 4 }); return ch2.map(v => sat.process(v * (rb.reeseSat?.pre ?? 1.5)) * 0.7); }));
            add(bus.bass, n, start, b.gain ?? 0.9);
          } else if (b.engine === 'growl') {
            const n = wt({ preset: 'formant-growl', midi, duration: dur, gain: rb.growl?.gain ?? 0.8, seed: seed + bar, lfo: rb.growl?.lfo, cutoff: rb.growl?.cutoff, resonance: rb.growl?.resonance, ...(rb.growl?.patch ?? {}) }, `g|${midi}|${dur.toFixed(4)}|${seed + bar}`);
            add(bus.bass, n, start, b.gain ?? 0.9);
          } else if (b.engine === 'sq1bit') {
            const hz = 440 * 2 ** ((midi - 69) / 12), frames = Math.round(dur * SR), buf = new Float32Array(frames), amp = rb.sq1bit?.level ?? 0.5; let ph = 0;
            for (let k = 0; k < frames; k++) { ph = (ph + hz / SR) % 1; buf[k] = (ph < 0.5 ? amp : -amp) * Math.min(1, k / 60, (frames - k) / 60); }
            add(bus.bass, buf, start, b.gain ?? 0.9);
          } else if (b.engine === 'sub') {
            const hz = 440 * 2 ** ((midi - 69) / 12), frames = Math.round(dur * SR), buf = new Float32Array(frames); let ph = 0;
            for (let k = 0; k < frames; k++) { ph += hz / SR; buf[k] = Math.sin(2 * Math.PI * ph) * 0.8 * Math.min(1, k / 200, (frames - k) / 400); }
            add(bus.bass, buf, start, b.gain ?? 0.9);
          }
        }
      }
      if (b.engine === 'acid') {
        const p = JSON.parse(readFileSync(join(E.repo, 'apps', 'acid-bass', 'presets', `${rb.acid.preset}.json`), 'utf8'));
        const key = `${rb.acid.preset}|${bpm}`;
        const acid = acidCache.acid.get(key) ?? norm(ACID.renderAcidPattern(p, { ...p.params, tempo: bpm, sampleRate: SR, cycles: 4, rootMidi: recipe.tonic, drive: rb.acid.drive ?? 0.6 }).samples, 0.6);
        acidCache.acid.set(key, acid);
        const len = acid.length / SR;
        for (let t = barT(from + (b.from ?? 0)); t < barT(to - (b.until ?? 0)) - 0.01; t += len) add(bus.bass, acid, t, b.gain ?? 0.55, 0.1);
      }
    }
    for (const [relBar, beatPos, gain = 0.8, secs = 2.5] of sec.subdrops ?? []) add(bus.bass, TRAILER.render({ kind: 'subdrop', seconds: secs, intensity: 0.8, pitch: recipe.tonic, seed: seed + relBar + 9 }, { sampleRate: SR }), t0 + relBar * BAR + beatPos * BEAT, gain);

    // 5. impacts, risers, whooshes
    if (sec.impact) {
      add(bus.fxr, TRAILER.render({ kind: 'impact', seconds: 1.2, intensity: 0.9, seed: seed + 3 }, { sampleRate: SR }), t0, 0.6 * sec.impact);
      add(bus.bass, TRAILER.render({ kind: 'subdrop', seconds: 2.5, intensity: 0.8, pitch: recipe.tonic, seed: seed + 9 }, { sampleRate: SR }), t0, 0.6 * sec.impact);
      if (hits.crash) add(bus.drums, hits.crash, t0, 0.8 * sec.impact);
    }
    if (sec.riser) add(bus.fxr, TRAILER.render({ kind: 'riser', seconds: bars * BAR - 0.05, intensity: sec.riser.intensity ?? 0.9, seed: seed + sec.index * 5 + 4 }, { sampleRate: SR }), t0, sec.riser.gain ?? 0.55);
    if (sec.whooshIn) add(bus.fxr, TRAILER.render({ kind: 'reverse', seconds: 2, intensity: 0.8, seed: seed + 5 }, { sampleRate: SR }), t0 - 2, sec.whooshIn);

    // 6. vocal formant chops
    const v = sec.vox, rv = recipe.vox ?? {};
    if (v?.stab) {
      const sp = rv.stab, patNames = String(v.stab).split(',');
      const voices = sp.midis.map((m, k) => { let w = formant(sp.preset, m + (sp.shift ?? 0), STEP * (sp.steps ?? 1.5), 20 + k); if (sp.rate && sp.rate !== 1) w = [w.left, w.right].map(ch2 => resample(ch2, sp.rate)); return w; });
      for (let bar = from + (v.from ?? 0); bar < to; bar++) for (const [st, idx, pan = (st % 2 ? 0.45 : -0.45)] of sp.patterns[patNames[rel(bar) % patNames.length]]) add(bus.vox, voices[(idx + bar) % voices.length], barT(bar) + st * STEP, v.gain ?? 0.42, pan);
    }
    if (v?.pad) for (let bar = from; bar < to; bar += (v.pad === 'talkbox-lead' ? 2 : 1)) {
      const ch = chordAt(bar), long = v.pad === 'talkbox-lead' ? 2 * BAR - 0.1 : BAR;
      add(bus.vox, formant(v.pad, v.pad === 'choir-pad' ? ch.notes[2] - 12 : ch.notes[0], long, bar + (v.pad === 'choir-pad' ? 50 : 0), v.pad === 'choir-pad' ? 0.6 : 0.7), barT(bar), v.padGain ?? 0.35, v.pad === 'choir-pad' ? 0.2 : 0);
    }
    if (v?.ooh) for (let bar = from; bar < to; bar += 2) add(bus.vox, formant('ooh-stab', 69 + (bar % 2) * 3, BEAT, 30 + (bar % 2), 0.8), barT(bar) + 3 * BEAT, v.ooh);

    // 6b. rave stab: a short brass chord hit from atelier-dsp textures
    if (sec.rave) {
      const rv2 = recipe.rave, pat = rv2.patterns[sec.rave.pattern];
      for (let bar = from; bar < to; bar++) {
        const ch = chordAt(bar);
        const stab = cached(`rave|${ch.notes.join('-')}|${rv2.preset}`, () => {
          const parts = ch.notes.map((n, k) => TX.renderBrass({ preset: rv2.preset, midi: n + (rv2.octave ?? 12), seconds: STEP * (rv2.steps ?? 2), sampleRate: SR, seed: seed + 40 + k, level: 0.7 }));
          const len = Math.max(...parts.map(p => p.left.length)), L = new Float32Array(len), R = new Float32Array(len);
          for (const p of parts) for (let i = 0; i < p.left.length; i++) { L[i] += p.left[i] * 0.45; R[i] += p.right[i] * 0.45; }
          return [L, R];
        });
        for (const st of pat) add(bus.vox, stab, barT(bar) + st * STEP, sec.rave.gain ?? 0.5, st % 2 ? 0.25 : -0.25);
      }
    }

    // 7. game sfx
    (sec.sfx ?? []).forEach(([rb2, beatPos, id], i) => add(bus.sfx, SFX.renderSfx(id, {}, 100 + sec.index * 10 + i).samples, t0 + rb2 * BAR + beatPos * BEAT, recipe.sfxGain ?? 0.45, ((i + sec.index) % 3 - 1) * 0.5));
  }

  // 8. distortion bus: bit reduction + sample hold into a 4x-oversampled tube saturator, set per section
  function crushDrive(buf, from, to, { bits, hold, drive, mix }) {
    const a = Math.round(from * SR), b = Math.min(TOTAL, Math.round(to * SR)), q = 2 ** (bits - 1);
    for (let c = 0; c < 2; c++) {
      const sat = FX.createSaturator({ mode: 'tube', oversample: 4, drive }); let held = 0;
      for (let i = a; i < b; i++) {
        if ((i - a) % hold === 0) held = Math.round(buf[c][i] * q) / q;
        const wet = sat.process(held) * 0.8, edge = Math.min(1, (i - a) / 400, (b - i) / 400);
        buf[c][i] = buf[c][i] * (1 - mix * edge) + wet * mix * edge;
      }
    }
  }
  for (const sec of tl.sections) for (const [name, o] of Object.entries(sec.dist ?? {})) { log(`dist ${sec.name} ${name}`); crushDrive(bus[name], barT(sec.from), barT(sec.to), o); }

  // 9. sum, tape colour, then tape-glitch edits on isolated windows
  const mix = stereo(), gains = { drums: 0.95, bass: 0.7, chip: 0.6, vox: 0.55, sfx: 0.5, fxr: 0.6, ...(recipe.mix ?? {}) };
  for (const k of BUSES) for (let c = 0; c < 2; c++) { const g = gains[k], s = bus[k][c], m = mix[c]; for (let i = 0; i < TOTAL; i++) m[i] += s[i] * g; }
  const mt = recipe.master?.tape ?? {};
  for (let c = 0; c < 2; c++) { let lp = 0; const k = 1 - Math.exp(-2 * Math.PI * (mt.lowpassHz ?? 13500) / SR); for (let i = 0; i < TOTAL; i++) { lp += (FX.saturate(mix[c][i] * (mt.drive ?? 0.9), 'tube', mt.sat ?? 1.4) - lp) * k; mix[c][i] = lp; } }
  const tapeBase = { ...TAPE.defaultPreset(), stopTime: 0.6, startTime: 0.15, stutterMs: 60, crushBits: 6, crushHold: 6, dropoutRate: 18, dropoutMs: 22, dropoutDepth: 0.9, wowDepth: 0.05, wowRate: 1.6, flutterDepth: 0.012, gain: 1, ...(recipe.tape?.preset ?? {}) };
  const tapeEdit = (fromBar, nBars, gestures, preset, sd) => {
    const a = Math.round(barT(fromBar) * SR), n = Math.min(Math.round(nBars * BAR * SR), TOTAL - a), B = BAR;
    if (n <= 0) return;
    const out = TAPE.render({ channels: mix.map(ch => ch.slice(a, a + n)), sampleRate: SR, preset, gestures: gestures.map(g => ({ type: g.type, t0: g.t0 * nBars * B, t1: g.t1 * nBars * B })), duration: n / SR, loop: false, seed: sd });
    const xf = 256;
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { const w = Math.min(1, i / xf, (n - 1 - i) / xf); mix[c][a + i] = mix[c][a + i] * (1 - w) + out.channels[c][i] * w; }
  };
  for (const sec of tl.sections) (sec.tape ?? []).forEach((t, k) => { log(`tape ${sec.name} +${t.bar}`); tapeEdit(sec.from + t.bar, t.bars, t.gestures, { ...tapeBase, ...(t.preset ?? {}) }, seed + sec.from + t.bar + k); });
  { const a = Math.round(barT(tl.bars) * SR); for (let c = 0; c < 2; c++) for (let i = a; i < TOTAL; i++) mix[c][i] *= Math.max(0, 1 - (i - a) / (0.2 * SR)); }

  // 10. master
  log('master');
  const result = masterBus(mix, recipe, { FX, ceilingDbfs: opts.ceilingDbfs, targetLufs: opts.targetLufs, iterations: opts.loudnessIterations ?? 3, log });
  return { channels: result.channels, sampleRate: SR, timeline: tl, totalFrames: TOTAL, master: result.info, engines: { dsp: E.dsp, repo: E.repo } };
}

// ---------- mastering ----------
// 16.5 kHz 4th-order lowpass (trims crush aliasing that causes inter-sample overs), glue compressor, tanh stage,
// then a gain search so integrated loudness lands on target through a two-pass lookahead limiter with 4x true-peak detection.
export function limit(ch, ceiling) {
  const look = Math.round(0.003 * SR), rel = Math.exp(-1 / (0.08 * SR)), n = ch[0].length, need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(M.truePeakAt(ch[0], i), M.truePeakAt(ch[1], i));
    need[i] = p > ceiling ? ceiling / p : 1;
    if (i > 0 && need[i] < need[i - 1]) need[i - 1] = need[i];
  }
  let env = 1;
  for (let i = 0; i < n; i++) {
    let m = 1; for (let j = i; j < Math.min(n, i + look); j++) if (need[j] < m) m = need[j];
    env = m < env ? m : m + (env - m) * rel; if (env > m) env = m;
    ch[0][i] *= env; ch[1][i] *= env;
  }
}
export function masterBus(mix, recipe, { FX, ceilingDbfs, targetLufs, iterations = 3, log = () => {} }) {
  const m = recipe.master ?? {}, TOTAL = mix[0].length;
  for (let c = 0; c < 2; c++) for (const q of [0.5412, 1.3066]) biquadLow(mix[c], m.lowpassHz ?? 16500, q);
  const cp = m.comp ?? {}, comp = FX.createCompressor(SR, { thresholdDb: cp.thresholdDb ?? -14, ratio: cp.ratio ?? 3, attack: 0.008, release: cp.release ?? 0.15, makeupDb: cp.makeupDb ?? 4 });
  const o = [0, 0];
  for (let i = 0; i < TOTAL; i++) { comp.process(mix[0][i], mix[1][i], o); mix[0][i] = Math.tanh(o[0] * 0.9); mix[1][i] = Math.tanh(o[1] * 0.9); }
  const target = targetLufs ?? m.targetLufs ?? -10.5, ceilDb = ceilingDbfs ?? m.ceilingDbfs ?? -1.6, ceiling = 10 ** (ceilDb / 20);
  const l0 = M.integratedLufs(mix, SR);
  let g = Number.isFinite(l0) ? 10 ** ((target + 1.5 - l0) / 20) : 1, work = null, lufs = l0, used = 0;
  for (let it = 0; it < iterations; it++) {
    used = it + 1;
    work = mix.map(c => { const w = new Float32Array(TOTAL); for (let i = 0; i < TOTAL; i++) w[i] = c[i] * g; return w; });
    limit(work, ceiling); limit(work, ceiling);
    for (const c of work) for (let i = 0; i < TOTAL; i++) c[i] = Math.max(-ceiling, Math.min(ceiling, c[i]));
    lufs = M.integratedLufs(work, SR);
    log(`master pass ${used}: gain ${(20 * Math.log10(g)).toFixed(2)} dB, ${lufs.toFixed(2)} LUFS (target ${target})`);
    if (!Number.isFinite(lufs) || Math.abs(lufs - target) < 0.3) break;
    g *= 10 ** (clamp(target - lufs, -6, 6) / 20);
  }
  return { channels: work, info: { targetLufs: target, ceilingDbfs: ceilDb, preLimiterGainDb: +(20 * Math.log10(g)).toFixed(2), passes: used, jsLufs: +lufs.toFixed(2) } };
}

// ---------- preview recipe for fast tests ----------
// The first drop, cut to `bars` bars, with everything that sits inside those bars kept.
export function previewRecipe(recipe, bars = 8) {
  const drop = recipe.sections.find(s => s.role === 'drop');
  const cut = { ...drop, name: 'preview', role: 'drop', bars, riser: undefined, whooshIn: undefined,
    sfx: (drop.sfx ?? []).filter(h => h[0] < bars),
    tape: (drop.tape ?? []).filter(t => t.bar + t.bars <= bars),
    subdrops: (drop.subdrops ?? []).filter(h => h[0] < bars) };
  return { ...recipe, sections: [cut] };
}

// ---------- analysis of a finished track ----------
export function analyse(channels, tl, recipe = null, sampleRate = SR) {
  const q = M.quantise16(channels);
  const peak = M.samplePeak(q), barF = Math.round(tl.bar * sampleRate);
  const dropFrames = tl.sections.filter(s => s.role === 'drop');
  const dropFlux = []; let hop = 0;
  const profiles = dropFrames.map(s => M.spectralProfile(q, sampleRate, { from: Math.round(s.from * barF), to: Math.min(q[0].length, Math.round(s.to * barF)) }));
  for (const p of profiles) { dropFlux.push(...p.flux); hop = p.hopSeconds; }
  const whole = M.spectralProfile(q, sampleRate, { from: 0, to: Math.round(tl.bars * barF) });
  const dropShare = profiles.length ? Object.fromEntries(['sub', 'low', 'mid', 'high'].map(k => [k, profiles.reduce((a, p) => a + p.bandShare[k], 0) / profiles.length])) : null;
  // tape edits the recipe asked for, and what the finished audio does inside each tape stop
  const edits = {}, stops = []; let wowBars = 0;
  if (recipe) for (const sec of tl.sections) for (const t of sec.tape ?? []) {
    const a = Math.round((sec.from + t.bar) * barF), span = t.bars * barF;
    for (const g of t.gestures) {
      edits[g.type] = (edits[g.type] ?? 0) + 1;
      if (g.type === 'wow') wowBars += t.bars * (g.t1 - g.t0);
      if (g.type !== 'stop') continue;
      const g0 = a + Math.round(g.t0 * span), g1 = Math.min(q[0].length, a + Math.round(g.t1 * span)), len = g1 - g0;
      if (len < 4096) continue;
      const before = M.rmsDb(q, g0 - Math.round(0.1 * barF), g0), tail = M.rmsDb(q, g1 - Math.round(len * 0.25), g1);
      const early = M.spectralProfile(q, sampleRate, { from: g0, to: g0 + Math.round(len * 0.3) }).centroidHz, mid = M.spectralProfile(q, sampleRate, { from: g0 + Math.round(len * 0.3), to: g0 + Math.round(len * 0.6) }).centroidHz;
      stops.push({ section: sec.name, atBar: sec.from + t.bar, rmsBeforeDb: +before.toFixed(1), rmsEndDb: +tail.toFixed(1), centroidEarlyHz: Math.round(early), centroidMidHz: Math.round(mid) });
    }
  }
  return {
    peakDbfs: +M.db(peak).toFixed(2),
    truePeakDbtp: +M.db(M.truePeak(q)).toFixed(2),
    lufsJs: +M.integratedLufs(q, sampleRate).toFixed(2),
    lraJs: +M.loudnessRange(q, sampleRate).toFixed(1),
    rmsDbfs: +M.rmsDb(q, 0, Math.round(tl.bars * barF)).toFixed(2),
    nonFinite: M.countNonFinite(channels),
    flatTopRuns: M.flatTopRuns(q),
    silentBars: M.silentBars(q, barF, tl.bars),
    centroidHz: Math.round(whole.centroidHz),
    bandShare: Object.fromEntries(Object.entries(whole.bandShare).map(([k, v]) => [k, +v.toFixed(3)])),
    dropBandShare: dropShare && Object.fromEntries(Object.entries(dropShare).map(([k, v]) => [k, +v.toFixed(3)])),
    dropOnsetsPerSec: dropFlux.length ? +M.onsetDensity(dropFlux, hop).toFixed(2) : null,
    dropGrid: dropFlux.length ? (g => g && { localBpm: +g.localBpm.toFixed(2), relative: +g.relative.toFixed(2) })(M.gridLock(dropFlux, hop, tl.bpm)) : null,
    dropTempo: dropFlux.length ? (t => t && { bpm: +t.bpm.toFixed(1), strength: +t.strength.toFixed(2) })(M.estimateTempo(dropFlux, hop, 60, 220)) : null,
    plrDb: +(M.db(peak) - M.integratedLufs(q, sampleRate)).toFixed(1),
    tapeEdits: { counts: edits, wowBars: +wowBars.toFixed(1), stops },
    sectionRmsDb: tl.sections.map(s => ({ name: s.name, role: s.role, bars: s.bars, rmsDb: +M.rmsDb(q, Math.round(s.from * barF), Math.round(s.to * barF)).toFixed(1) })),
  };
}
