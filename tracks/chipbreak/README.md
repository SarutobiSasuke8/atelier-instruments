# Chipbreak tune pack

Eight original tunes that mix chiptune arps, chopped breakbeats, tape damage and heavy distortion, one per sub-style. Every sound is synthesised by [atelier-dsp](https://github.com/SarutobiSasuke8/atelier-dsp) and the engines in `apps/`. The atelier-dsp repository is not public yet, so you need access to it to re-render these tracks. The apps in this repository do not depend on it. There are no samples and no third-party audio. The break patterns, melodies and chord loops are our own. Nothing here is named after, or copies, a real artist, label or track. MIT.

Nobody has listened to these yet. Every figure below was measured from the audio, and the notes under each track say so.

## Tracks

| id | style | BPM | length | peak dBFS | true peak dBTP (WAV / MP3) | LUFS | LRA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chip-breakcore | breakcore, chip breaks | 190 | 1:41 | -1.9 | -1.5 / -1.4 | -10.5 | 7.2 |
| tape-warped-jungle | jungle, tape music, chip breaks | 168 | 2:06 | -1.6 | -1.5 / -1.3 | -10.8 | 5.0 |
| glitch-hop-chip | glitch hop, chip breaks, game funk | 100 | 1:46 | -1.6 | -1.5 / -1.3 | -10.5 | 6.3 |
| nightcore-speed-chip-rave | nightcore, rave, happy hardcore | 176 | 1:49 | -1.6 | -1.6 / -1.3 | -9.7 | 3.7 |
| distorted-8bit-dnb | drum and bass, chip breaks, distorted | 174 | 1:50 | -1.6 | -1.6 / -1.5 | -10.1 | 6.9 |
| lofi-tape-chip-breaks | lo-fi, chip breaks, tape | 86 | 1:40 | -1.6 | -1.6 / -1.6 | -11.3 | 2.4 |
| gabber-chip | gabber, hardcore, chiptune | 190 | 1:41 | -2.0 | -1.8 / -1.8 | -9.8 | 3.0 |
| halftime-chip-dubstep | dubstep, half-time, chip bass | 140 | 1:50 | -1.6 | -1.5 / -1.3 | -10.3 | 6.3 |

Peak, true peak, LUFS and LRA come from `ffmpeg` (`astats` and `ebur128=peak=true`) on the written WAV. The MP3 column is the true peak of the 320k MP3 decoded again. The MP3 sample peaks are between -1.3 and -1.9 dBFS. Everything is at or under -1 dBFS and -1 dBTP on both formats, and inside -9 to -12 LUFS. Full figures, per-section loudness and the signature measurements are in `meta/<id>.stats.json`. The titles are `Shard Counter`, `Slow Reel Rollers`, `Crunch Cartridge Shuffle`, `Sugar Rush Hardcore`, `One Bit Burnout`, `Dusty Cassette Corridor`, `Square Wave Stampede` and `Cartridge Wobble Cathedral`.

## Regenerate

```bash
# atelier-dsp (main) checked out anywhere; ffmpeg on PATH
ATELIER_DSP=/path/to/atelier-dsp node tracks/chipbreak/render.mjs --all
ATELIER_DSP=/path/to/atelier-dsp node tracks/chipbreak/render.mjs chip-breakcore gabber-chip --out /some/dir
```

`ATELIER_DSP` can be left out when the checkout sits beside this repo as `../atelier-dsp`. Audio goes to `tracks/chipbreak/out/` (ignored by git); sidecars go to `tracks/chipbreak/meta/`. A track takes 25 to 55 seconds to render and the output is deterministic for a recipe and its seed. The WAVs are 44.1 kHz, 16-bit, stereo and the MP3s are 320k. The audio is not committed because each WAV is about 20 MB.

To rebuild the table above from the sidecars: `node tracks/chipbreak/stats-table.mjs`.

## How it works

- **`arranger.mjs`** turns a recipe into a mastered stereo track. It also holds recipe validation, chop-token parsing and the analysis used for the stats. Recipe validation and chop parsing need no engines.
- **`recipes/<id>.json`** is one recipe per track: tempo, key and chord loop, section list in bars, the break kit and its 16-step pattern, named chop patterns, chip lanes and lead phrases, bass engine and bass patterns, vocal chops, game-SFX hits, distortion settings per bus per section, tape-edit windows and a seed.
- **`measure.mjs`** is the measurement code: BS.1770 loudness, loudness range, 4x true peak, flat-top and silence checks, band shares, onset density and tempo-grid lock.
- **`render.mjs`** renders, writes the WAV and MP3, measures both with ffmpeg and writes the sidecars. If an encode lands above the -1 dB limits it trims the file and encodes again (it did not need to).
- **`sidecar.mjs`** builds the sidecars.

### Break and chop tokens

One 16-step bar is built from atelier-dsp groovebox pad voices (kick, snare, ghost snare, hats, ride, crash), pre-driven and cut into 16 slices. A chop pattern is 16 tokens, one per 16th step, that re-sequence the slices. A token is a slice number from 0 to 15 followed by any of these marks.

| Mark | Meaning |
| --- | --- |
| `r` | reverse the slice |
| `^` | pitch up, x1.5 per mark, capped at x4 |
| `v` | pitch down, x0.66 per mark |
| `*` | stutter: loop the first half of the slice, and each extra `*` halves it again, down to an eighth |
| `.` | rest (on its own) |

For example `4 4 4* 4 12^ 12^* 12^** .` is a snare-slice roll that climbs in pitch and speeds up. A recipe may set `break.swing` to delay every odd 16th, and `break.crush` or `break.lowpassHz` to dirty the source break.

### Signal path

Chip lanes (`renderChiptune`: arp stabs, pulse or triangle lead, triangle bass, noise hats), a ratcheted arp layer, bass (`reese`, `reese-sat` with a 4x-oversampled tube saturator, `acid`, a 1-bit square, a sine `sub` or a wobbling `growl`), vocal-formant chops and a brass `rave` stab, game-SFX hits and trailer-riser risers, impacts and sub drops are summed into six buses. A bit-reduction and sample-hold stage into a 4x-oversampled tube saturator is set per bus per section. The buses are summed, given tape colour, and then `tape-glitch` edits (stop, start, stutter, reverse, crush, dropout, wow, flutter) run on isolated 1 to 8 bar windows so a tape stop cannot desync the rest of the track.

### Mastering

A 16.5 kHz 4th-order lowpass removes the crush aliasing that caused inter-sample overs, then a glue compressor and a tanh stage run. A gain search then lands integrated loudness on the track's target (-9.8 to -11.5 LUFS) through a two-pass lookahead limiter with 4x windowed-sinc true-peak detection at -1.6 dBFS. The limiter is the one from the demo script. ffmpeg is the independent check on all of it.

### Engines

| Engine | Repo and commit used for the committed stats |
| --- | --- |
| groovebox `renderPad`, wavetable (reese, formant growl), chiptune, formant, brass, saturate, createSaturator, createCompressor | `SarutobiSasuke8/atelier-dsp@9ca58bc` (main) |
| tape-glitch, game-sfx, trailer-riser, acid-bass | `SarutobiSasuke8/atelier-instruments@9981f47` (main, `apps/`) |

The ratcheted arp is a small local equivalent written for this pack (`ratchet` in the arranger), so there is no dependency on the unmerged `grok/arp-lab` branch. The `vocoder`, `vowel-choir-pad`, `theremin` and `pedal-dsp` engines are not used.

## Measured signature notes

These are not listening notes. They are what the numbers say about each track's signature. "Drop" figures are measured on the drop sections only. "Grid lock" is the strength of onset pulse within 2% of the nominal tempo, as a fraction of the strongest pulse anywhere from 40 to 420 BPM (1.0 means the nominal grid is the strongest pulse). The strongest pulse is often at half the tempo, which still counts as the same grid.

- **chip-breakcore.** 42 of the 112 tokens in the drop chop sets carry a stutter, pitch or reverse mark, and 9 stutter, 4 reverse and 5 tape-stop edits run through the track. Grid lock at 189.75 BPM is 0.82 and the strongest pulse is at 95, half the tempo. Drops sit at -10.6 to -11.2 dB RMS against -15.3 in the breakdown, and 3 of the 5 stops lose 6 dB or more by the end of the gesture.
- **tape-warped-jungle.** Wow and flutter windows cover 79 bars of the 88, across every section including the outro. All 5 of its stops show the spectral centroid falling and 3 lose 6 dB or more, which is the pitch dive into a drop. Reese bass runs through a 4x-oversampled saturator in every drop. Grid lock at 168 BPM is 0.65 and the strongest pulse is at 84, half the tempo. The drop chop sets are mostly re-sequenced slices (2 of 80 tokens carry a modifier), so the stutter content is in the build rolls and tape edits.
- **glitch-hop-chip.** The break is swung (delay of 0.2 of a 16th on odd steps) with the snare on beat 3, the half-time position. Grid lock at 100 BPM is 0.84. The chip bus is crushed to 4 bits in the second drop and there are 21 game-SFX hits across the three drops. 3 of the 4 stops lose 6 dB or more.
- **nightcore-speed-chip-rave.** Major key (C major, I V vi IV), kick on every beat with a clap on 2 and 4, a brass chord stab and formant chops rendered an octave up and sped by 1.25x. The pulse estimator picked 117.5 BPM, a 2:3 ratio to the 176 grid, so grid lock at 176 is only 0.78 and the tempo is not confirmed beyond that. Drop energy above 500 Hz is 9.7%, more than gabber (6.5%) and lofi (3.1%) but less than breakcore (17.6%). The track is more bass-heavy than "bright" suggests, so that is the one to judge by ear first.
- **distorted-8bit-dnb.** The best tempo lock of the set: grid lock 0.91 at 173.75 BPM and the strongest pulse is at the nominal tempo. The first drop plays a 1-bit square bass (the voice outputs only +0.5 or -0.5, apart from 1.4 ms gate ramps, before it reaches the bus) and the second a saturated reese. The third plays both. The drum bus is crushed to 7 bits in the second drop and 6 in the third. 4 of 5 stops lose 6 dB or more.
- **lofi-tape-chip-breaks.** The darkest track: 0.1% of drop energy above 4 kHz, 3% above 500 Hz and a spectral centroid of 214 Hz over the whole track, against 270 to 1241 Hz for the other seven. Wow and flutter cover 31 of 36 bars with 3 dropout edits. The softest crush in the pack (8 bits at the lowest). LRA is 2.4 LU, the narrowest, so expect little level movement. Grid lock at 86 BPM is 0.60, the weakest, which fits the swung, low-pass-smeared break.
- **gabber-chip.** The most compressed: peak-to-loudness 7.8 dB against 8.1 to 9.7 for the others, and the lowest LRA after lofi (3.0 LU). The overdriven kick is a groovebox kick pushed through tanh at drive 7 and then a tube saturator at drive 5 to 7 on the drum bus, so energy under 100 Hz is 35% and above 500 Hz is only 6.5%. Kick on every beat. Grid lock at 189.75 BPM is 0.71.
- **halftime-chip-dubstep.** Perfect tempo lock at 140 BPM (grid lock 1.00, strongest pulse at 139.75). The growl bass is the wavetable formant-growl voice with its cutoff modulated at an eighth note, which is a wobble at 140 BPM, and the sub drops are 2 in the first drop and 4 in the second, on top of the impact and sub drop at each drop start. The breakdown is 1.8 dB lower than drop 1 and 3.2 dB lower than drop 2. 3 of 5 stops lose 6 dB or more by the end of the gesture.

Across all 38 tape stops, 27 end at least 6 dB below where they started and 34 show the centroid falling. The ones that do not are mostly the short stops at the end of a build, where the gesture window is shorter than the stop time, so the tape is still slowing when the drop hits.

## Sidecars

`meta/<id>.meta.json` is `lmms-mcp-meta/1`. `lmms-mcp` checks sidecars strictly and ignores a file with a field it does not define, so these use only its field names (`title`, `composer`, `era`, `genre`, `mood`, `arrangement`, `instrumentation`, `durationSeconds`, `loop`, `licence`, `date`, `kind`, `tags`, `notes`). Two differences from the ticket follow from that. `kind` is `piece` because `lmms-mcp` has no `track` kind, and the length is `durationSeconds`.

Everything `lmms-mcp` has no field for goes in `meta/<id>.stats.json` (`chipbreak-stats/1`, `kind: "track"`): `bpm`, `key`, `durationSec`, `seed`, `peakDbfs`, `truePeakDbtp`, `lufs`, `lra`, `licence`, `engines` as repo@sha, the WAV and MP3 measurements and the analysis. The measurements are also written into the `notes` of the meta file.

`licences.json` records third-party audio. There is none.

## Tests

```bash
node --test                                              # from the repo root: every app and this pack
node --test tracks/chipbreak/test/chipbreak.test.mjs     # this pack only
```

`npm test` runs both too. The tests are offline. Recipe validation (all eight recipes plus negative cases), chop-token parsing, the loudness, true-peak, flat-top and silence meters, the sidecars and the no-large-audio guard need nothing else. The eight-bar render tests (each recipe's first drop cut to 8 bars: finite, not silent, no silent bar, sample peak and true peak at or below -1, no flat-topped run, and byte-identical for the same seed on two recipes) need an atelier-dsp checkout and skip with a message without one.
