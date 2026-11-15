# Contributing

Run `npm test` before opening a pull request. Use `npm run serve` to try browser changes on localhost. For input changes, check keyboard and pointer first, then MIDI or microphone where applicable.

Keep each instrument under `apps/<name>/`. Keep the engine usable outside the DOM, put browser wiring under `ui/`, and add tests for deterministic renders and preset compatibility. Use the helpers in `shared/` for common work. Link a new app from the launcher and include a README with its input map and a compact screenshot.

Submit original code and presets. Use procedural factory audio and include the provenance of any asset you propose adding. Keep credentials, local machine paths and personal material out of commits and screenshots. If something sensitive entered Git history, tell a maintainer privately.
