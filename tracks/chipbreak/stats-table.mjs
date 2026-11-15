// Print the README stats table from tracks/chipbreak/meta/*.stats.json.   node tracks/chipbreak/stats-table.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const meta = join(dirname(fileURLToPath(import.meta.url)), 'meta');
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const rows = readdirSync(meta).filter(f => f.endsWith('.stats.json')).sort().map(f => JSON.parse(readFileSync(join(meta, f), 'utf8')));
console.log('| id | style | BPM | length | peak dBFS | true peak dBTP (WAV / MP3) | LUFS | LRA |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const s of rows) console.log(`| ${s.id} | ${s.genre.join(', ')} | ${s.bpm} | ${mmss(s.durationSec)} | ${s.peakDbfs.toFixed(1)} | ${s.truePeakDbtp.toFixed(1)} / ${s.mp3.truePeakDbtp.toFixed(1)} | ${s.lufs.toFixed(1)} | ${s.lra.toFixed(1)} |`);
