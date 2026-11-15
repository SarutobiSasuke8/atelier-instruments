// Render the chipbreak tracks: WAV (44.1 kHz, 16-bit), MP3 (320k), sidecars and a measurement report.
//
//   ATELIER_DSP=<atelier-dsp checkout> node tracks/chipbreak/render.mjs --all
//   ATELIER_DSP=<atelier-dsp checkout> node tracks/chipbreak/render.mjs chip-breakcore gabber-chip --out some/dir
//
// Options: --all | <id> ...   --out <dir> (audio, default tracks/chipbreak/out)   --meta <dir> (sidecars, default tracks/chipbreak/meta)
//          --no-mp3           --quiet
// Needs ffmpeg on PATH (or FFMPEG=<path>) for the MP3 and for the independent loudness and true-peak measurement.
// A 2-3 minute track takes about two minutes to render. Output is deterministic for a given recipe seed.
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderTrack, loadRecipe, recipeIds, analyse, loadEngines, gitSha, REPO, SR } from './arranger.mjs';
import { encodeWav16, quantise16, samplePeak, db } from './measure.mjs';
import { buildMeta, buildStatsFile, checkMeta } from './sidecar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

export function ffmpegMeasure(file) {
  const run = args => spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, ...args, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stderr;
  const e = run(['-filter_complex', 'ebur128=peak=true:framelog=quiet']);
  const a = run(['-af', 'astats=metadata=0']);
  const grab = (text, re) => { const m = re.exec(text); return m ? +m[1] : null; };
  const overall = a.slice(a.lastIndexOf('Overall'));
  return {
    lufs: grab(e, /I:\s+(-?[\d.]+) LUFS/), lra: grab(e, /LRA:\s+(-?[\d.]+) LU/), truePeakDbtp: grab(e, /Peak:\s+(-?[\d.]+) dBFS/),
    samplePeakDbfs: grab(overall, /Peak level dB:\s+(-?[\d.]+)/),
  };
}

export async function renderToFiles(id, { out, meta, mp3 = true, log = () => {}, engines } = {}) {
  const recipe = loadRecipe(id);
  const started = Date.now();
  const res = await renderTrack(recipe, { engines, log });
  const channels = res.channels, tl = res.timeline;
  const base = join(out, id), wavPath = `${base}.wav`, mp3Path = `${base}.mp3`;
  mkdirSync(out, { recursive: true }); mkdirSync(meta, { recursive: true });
  // The file must clear -1 dBFS sample peak and -1 dBTP on the MP3. If the encode overshoots, trim the whole file and re-encode.
  let trimDb = 0, wavM, mp3M;
  for (let attempt = 0; attempt < 4; attempt++) {
    const g = 10 ** (trimDb / 20), scaled = trimDb ? channels.map(c => c.map(v => v * g)) : channels;
    writeFileSync(wavPath, encodeWav16(scaled, SR));
    wavM = ffmpegMeasure(wavPath);
    if (mp3) { const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '320k', mp3Path], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`ffmpeg mp3 encode failed: ${r.stderr}`); mp3M = ffmpegMeasure(mp3Path); }
    const worst = Math.max(wavM.samplePeakDbfs ?? 0, wavM.truePeakDbtp ?? 0, mp3M?.samplePeakDbfs ?? -99, mp3M?.truePeakDbtp ?? -99);
    if (worst <= -1.05) { for (let c = 0; c < 2; c++) channels[c] = scaled[c]; break; }
    trimDb -= (worst + 1.25); log(`over the ceiling (${worst} dB): trimming ${trimDb.toFixed(2)} dB`);
  }
  const analysis = analyse(channels, tl, recipe);
  const stats = {
    durationSec: +(tl.seconds).toFixed(2), peakDbfs: wavM.samplePeakDbfs, truePeakDbtp: wavM.truePeakDbtp, lufs: wavM.lufs, lra: wavM.lra,
    wav: { file: `${id}.wav`, bytes: statSync(wavPath).size, ...wavM },
    mp3: mp3 ? { file: `${id}.mp3`, bytes: statSync(mp3Path).size, ...mp3M } : null,
    analysis, renderSeconds: +((Date.now() - started) / 1000).toFixed(1), master: res.master,
  };
  const E = engines ?? await loadEngines();
  const engineList = [`atelier-dsp@${gitSha(E.dsp)}`, `atelier-instruments@${gitSha(E.repo)}`];
  const m = buildMeta(recipe, stats);
  const problems = checkMeta(m);
  if (problems.length) throw new Error(`sidecar problems: ${problems.join('; ')}`);
  writeFileSync(join(meta, `${id}.meta.json`), JSON.stringify(m, null, 2) + '\n');
  writeFileSync(join(meta, `${id}.stats.json`), JSON.stringify(buildStatsFile(recipe, stats, engineList), null, 2) + '\n');
  return { recipe, stats, engines: engineList };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const ids = args.includes('--all') ? recipeIds() : args.filter((a, i) => !a.startsWith('--') && !['--out', '--meta'].includes(args[i - 1]));
  if (!ids.length) { console.error('Usage: node tracks/chipbreak/render.mjs --all | <id> ... [--out dir] [--meta dir] [--no-mp3]'); process.exit(2); }
  const out = resolve(opt('--out') ?? join(HERE, 'out')), meta = resolve(opt('--meta') ?? join(HERE, 'meta'));
  const engines = await loadEngines();
  for (const id of ids) {
    const log = args.includes('--quiet') ? () => {} : m => console.error(`  [${id}] ${m}`);
    const { stats } = await renderToFiles(id, { out, meta, mp3: !args.includes('--no-mp3'), log, engines });
    console.log(JSON.stringify({ id, seconds: stats.durationSec, peak: stats.peakDbfs, tp: stats.truePeakDbtp, lufs: stats.lufs, lra: stats.lra, mp3tp: stats.mp3?.truePeakDbtp, renderSeconds: stats.renderSeconds }));
  }
}
