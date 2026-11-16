# Launch audit

Source baseline `02016d86da42fe5e0c4d9d3bb9a95ad1553ef683`. The five required apps are on the default branch, including Creature Sound Generator and Robot Voice Vocoder from PRs #12 and #13. This review covers all 11 apps at that baseline.

## App and shared-code review

Pass means the tracked source, presets, docs and tests showed no identifiable third-party code, supplied audio samples, borrowed presets, or real artist and equipment-brand names. Review included the tracked file inventory, module imports, preset and sample construction, comments and fixture names, targeted text searches and commit provenance. It is a repository review. The maintainers should confirm authorship before release, including the implementations of common DSP formulas and file formats.

| Scope | Result | Evidence |
| --- | --- | --- |
| [Acid Bass Box](apps/acid-bass/) | Pass | Procedural oscillator and filter, step patterns and original JSON patches. |
| [Ambience](apps/ambience/) | Pass | Seeded procedural texture layers and original JSON patches. |
| [Arpeggiator Lab](apps/arp-lab/) | Pass | Note scheduling, offline synthesis and original factory patterns. |
| [Chord Pad Player](apps/chord-pads/) | Pass | Voicing, synthesized voices and original JSON progressions. |
| [Creature Sound Generator](apps/creature-sound-generator/) | Pass | Procedural creature voices and factory presets. Local WAV ZIP helper. |
| [Game Sound Effects Maker](apps/game-sfx/) | Pass | Procedural effects and factory presets. Local WAV ZIP helper. |
| [Pump Sweep](apps/pump-sweep/) | Pass | Procedurally built demo loop, filter and pump processing, JSON presets. |
| [Robot Voice Vocoder](apps/robot-voice-vocoder/) | Pass | Synthesized factory vowel and carrier. Optional mic or user file input. |
| [Tape Glitch](apps/tape-glitch/) | Pass | Generated demo reel, AudioWorklet processing and original preset data. |
| [Trailer Riser & Impact](apps/trailer-riser/) | Pass | Procedural effects and original JSON presets. |
| [Vowel Choir Pad](apps/vowel-choir-pad/) | Pass | Procedural oscillator and vowel formants, original JSON presets. |
| [Shared helpers](shared/) | Pass | Local keyboard and Web MIDI handling, MIDI and WAV writers, preset storage and CSS. |
| Pending pedalboard PR #9 | Hold outside this launch | `apps/pedalboard/main.js` and the optional Acid Bass integration load the private `atelier-dsp` engine. `shared/pedalboard/fonts/` contains four third-party fonts with SIL OFL notices. These files are absent from the audited default branch. |
| Pending chipbreak PR #10 | Outside app review | The branch and PR history were scanned for sensitive material. Review its separate source and generated assets if it becomes part of the release. |

The 11 small launch screenshots were captured from local app pages using factory defaults. No external browser requests were observed in that smoke test.

## Git history review

Scanned every reachable commit and blob from the fetched branches, tags, and all 13 available pull request head refs, including open PRs and the 12 commits on the default branch. The local scan covered 45 commits, 285 text blobs and 94 binary blobs. Patterns covered credential formats, inline secrets, bearer values, private keys, credentials embedded in URLs, absolute private paths and personal-data markers. It also inventoried binaries by type and checked text metadata in 90 images. Four review images on the pedalboard branch carried file timestamps. Binary font metadata received only a file-type and accompanying-notice check. Custom pattern checks can miss unknown formats, and Git cannot enumerate server-side objects absent from fetched refs.

- No credential, private-key or absolute private-path findings in the scanned text.
- **Review before visibility changes.** Git author and committer fields and co-author trailers contain non-`noreply` attribution addresses, including commit `02016d8`. Review their exposure with the maintainers. The published Shrikhand author contact in `shared/pedalboard/fonts/shrikhand-OFL.txt` on the pending pedalboard branch belongs to the font notice. Preserve the notice if that font is distributed.
- Confirm which branch and PR histories may become visible. Re-run the scan at the release commit if any code lands after this review.

## Static demo

The root launcher and its assets work under a repository-name prefix. The empty `.nojekyll` config lets GitHub Pages serve those static files directly. When Alexei approves the launch, the proposed source is the reviewed branch root. Pages settings are an operator step. [Branch publishing reference](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

Local Edge opened the launcher and all 11 apps with no page errors, failed requests or external calls. The check covered initial page load and asset resolution. Physical MIDI and microphone hardware were outside that check.

## Operator checklist

- [ ] Confirm MIT provenance for the exact app set and shared files to be released.
- [ ] Resolve Git attribution exposure and re-scan the final branches and PR history before changing visibility.
- [ ] Keep the private DSP integration outside the release or approve a public-safe standalone arrangement. Review OFL notices and all work merged after this audit.
- [ ] Review the 11 guides and screenshots and run `npm test`.
- [ ] When the repository is approved for public release, select the reviewed branch and root as the Pages source. Check audio, permission prompts and navigation on the public demo after enabling it.
