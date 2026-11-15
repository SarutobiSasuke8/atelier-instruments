// Sidecar files for the chipbreak tracks.
//
// <id>.meta.json  is an lmms-mcp-meta/1 sidecar. lmms-mcp checks sidecars strictly (an unknown field makes the file
//                 unreadable to its library page), so this one uses only field names that lmms-mcp already defines:
//                 title, composer, era, genre, mood, arrangement, instrumentation, durationSeconds, loop, licence,
//                 date, kind, tags, notes. `kind` is "piece" because lmms-mcp has no "track" kind.
// <id>.stats.json holds everything lmms-mcp has no field for: bpm, key, seed, engines (repo@sha), peak, true peak,
//                 LUFS, LRA and the signature measurements. It carries `kind: "track"`.
import { basename } from 'node:path';

export const META_FORMAT = 'lmms-mcp-meta/1';
export const STATS_FORMAT = 'chipbreak-stats/1';
// The fields lmms-mcp's sound-meta.mjs accepts (read from its `fields` table). Kept here so the test can run offline.
export const LMMS_META_FIELDS = ['title', 'composer', 'composed', 'era', 'genre', 'mood', 'gameUse', 'arrangement', 'instrumentation', 'durationSeconds', 'loop', 'source', 'licence', 'credits', 'date', 'kind', 'tags', 'notes', 'sourceNote'];
export const LMMS_KINDS = ['piece', 'sound', 'stem'];
export const LMMS_ARRANGEMENTS = ['straight', 'shaped', 'chiptune', 'dance', 'orchestral', 'ambient', 'jazz', 'original'];

export const INSTRUMENTATION = [
  'atelier-dsp groovebox pad voices (synthesised break)', 'atelier-dsp chiptune (pulse, triangle, noise lanes)', 'atelier-dsp wavetable (reese, formant growl)',
  'atelier-dsp formant (vocal chops)', 'atelier-instruments tape-glitch', 'atelier-instruments game-sfx', 'atelier-instruments trailer-riser', 'atelier-instruments acid-bass',
];

export function buildMeta(recipe, stats, { date = '2026-11-15' } = {}) {
  const notes = `Synthesised only, no samples. ${recipe.bpm} BPM, ${recipe.key}, seed ${recipe.seed}. `
    + `Measured: sample peak ${stats.peakDbfs} dBFS, true peak ${stats.truePeakDbtp} dBTP, ${stats.lufs} LUFS integrated, LRA ${stats.lra} LU. `
    + 'Full measurements and engine commits are in the matching .stats.json.';
  return {
    format: META_FORMAT,
    title: recipe.title,
    composer: 'Atelier Instruments',
    era: 'original',
    genre: [...new Set(['chiptune', 'dance', ...recipe.genre])].slice(0, 8),
    mood: recipe.mood.slice(0, 8),
    arrangement: 'chiptune',
    instrumentation: INSTRUMENTATION,
    durationSeconds: stats.durationSec,
    loop: false,
    licence: 'MIT (own work)',
    date,
    kind: 'piece',
    tags: ['chipbreak', recipe.style, `bpm-${recipe.bpm}`, `key-${recipe.key.toLowerCase().replace(/\s+/g, '-')}`, 'synthesised', 'no-samples'],
    notes,
  };
}
export function buildStatsFile(recipe, stats, engines) {
  return {
    format: STATS_FORMAT,
    id: recipe.id, title: recipe.title, kind: 'track', genre: recipe.genre, mood: recipe.mood,
    bpm: recipe.bpm, key: recipe.key, durationSec: stats.durationSec, seed: recipe.seed,
    peakDbfs: stats.peakDbfs, truePeakDbtp: stats.truePeakDbtp, lufs: stats.lufs, lra: stats.lra,
    licence: 'MIT (own work)', engines,
    wav: stats.wav, mp3: stats.mp3, analysis: stats.analysis,
  };
}
// Returns a list of problems against the lmms-mcp field rules.
export function checkMeta(meta) {
  const e = [];
  for (const k of Object.keys(meta)) if (k !== 'format' && !LMMS_META_FIELDS.includes(k)) e.push(`unknown lmms-mcp field "${k}"`);
  if (meta.format !== META_FORMAT) e.push('format must be lmms-mcp-meta/1');
  if (!LMMS_KINDS.includes(meta.kind)) e.push('kind must be piece, sound or stem');
  if (!LMMS_ARRANGEMENTS.includes(meta.arrangement)) e.push('arrangement is not an lmms-mcp value');
  for (const k of ['title', 'licence', 'composer']) if (typeof meta[k] !== 'string' || !meta[k] || meta[k].length > (k === 'title' ? 120 : 80)) e.push(`${k} is missing or too long`);
  for (const k of ['genre', 'mood', 'tags', 'instrumentation']) if (!Array.isArray(meta[k]) || !meta[k].length) e.push(`${k} must be a non-empty list`);
  if (!(meta.durationSeconds >= 0 && meta.durationSeconds <= 36000)) e.push('durationSeconds out of range');
  if (typeof meta.notes === 'string' && meta.notes.length > 2000) e.push('notes longer than 2000 characters');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? '')) e.push('date must be YYYY-MM-DD');
  return e;
}
export const fileBase = file => basename(file).replace(/\.(wav|mp3|meta\.json|stats\.json)$/i, '');
