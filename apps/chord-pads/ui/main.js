import {
  CHORD_TYPES,
  KEYS,
  PAD_LAYOUT,
  SCALE_IDS,
  SOUNDS,
  buildVoicing,
  describeChord,
  loopLengthBeats,
  noteName,
  planProgression,
  quantizeBeat,
  renderProgression,
  strumPlan,
  validateChordPreset,
} from "../engine.js";
import { bindHeldKeys, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { encodeMidiFile, midiOutputList, sendMidi, silenceMidiOutput } from "../../../shared/midi.js";
import {
  downloadTextFile,
  loadJson,
  pickTextFile,
  presetFilename,
  readJsonObject,
  storeJson,
} from "../../../shared/presets.js";
import { encodeWav, triggerDownload } from "../../../shared/wav-export.js";
import { createLiveOutput } from "./live-audio.js";

const STATE_KEY = "atelier:chord-pads:state";
const PRESET_KEY = "atelier:chord-pads:presets";
const KEY_LABELS = ["1", "2", "3", "4", "Q", "W", "E", "R", "A", "S", "D", "F", "Z", "X", "C", "V"];
const KEY_CODES = [
  "Digit1", "Digit2", "Digit3", "Digit4",
  "KeyQ", "KeyW", "KeyE", "KeyR",
  "KeyA", "KeyS", "KeyD", "KeyF",
  "KeyZ", "KeyX", "KeyC", "KeyV",
];
const SCALE_LABELS = {
  major: "Major",
  naturalMinor: "Natural minor",
  harmonicMinor: "Harmonic minor",
  dorian: "Dorian",
  mixolydian: "Mixolydian",
  majorPentatonic: "Major pentatonic",
  minorPentatonic: "Minor pentatonic",
};
const SOUND_LABELS = { pad: "Warm pad", piano: "Piano", pluck: "Pluck", supersaw: "Supersaw" };
const TYPE_LABELS = { triad: "Triad", "7th": "7th", "9th": "9th", sus: "Sus", add9: "Add9" };
const FACTORY = [
  ["night-corridor", "Night Corridor"],
  ["tape-window", "Tape Window"],
  ["warehouse-stairs", "Warehouse Stairs"],
  ["lantern-procession", "Lantern Procession"],
  ["radio-smile", "Radio Smile"],
];

const $ = (id) => document.getElementById(id);

const state = {
  key: "C",
  scale: "major",
  chordType: "triad",
  inversion: 0,
  spread: 0,
  voiceLeading: false,
  strumEnabled: false,
  strumSpeed: 18,
  strumDirection: "up",
  sound: "pad",
  bpm: 100,
  volume: 0.85,
  latch: false,
  loop: true,
  metronome: true,
  quantize: 8,
  midiBase: 48,
  midiOutId: "",
  progression: [],
  presetName: "My progression",
  recording: false,
  playing: false,
};

const held = new Map();
const lit = new Set();
let previousNotes = null;
let live = null;
let audioCtx = null;
let midiAccess = null;
let userPresets = [];
let factoryPresets = [];
const record = { origin: 0, pending: new Map() };
const clock = {
  mode: "idle",
  timer: null,
  origin: 0,
  nextClick: 0,
  nextLoop: 0,
  scheduled: new Set(),
  loopBeats: 4,
  plan: null,
  countIn: 0,
  timers: [],
};

function currentParams() {
  return {
    key: state.key,
    scale: state.scale,
    chordType: state.chordType,
    inversion: state.inversion,
    spread: state.spread,
    voiceLeading: state.voiceLeading,
    sound: state.sound,
    bpm: clamp(state.bpm, 40, 200),
    strum: {
      enabled: state.strumEnabled,
      speedMs: state.strumEnabled ? state.strumSpeed : 0,
      direction: state.strumDirection,
    },
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ensureAudio() {
  if (!audioCtx) {
    const Context = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Context();
    live = createLiveOutput(audioCtx);
    live.setVolume(state.volume);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function setStatus(text) {
  $("readout").textContent = text;
}

function persist() {
  const { recording, playing, ...rest } = state;
  storeJson(STATE_KEY, rest);
}

function activeOutput() {
  if (!midiAccess || !state.midiOutId) return null;
  return midiAccess.outputs.get(state.midiOutId) || null;
}

function sendChord(notes, velocity, delays) {
  const output = activeOutput();
  if (!output) return function noop() {};
  const vel = Math.max(1, Math.min(127, Math.round(velocity)));
  const timers = [];
  notes.forEach((note, index) => {
    const delay = Math.max(0, ((delays && delays[index]) || 0) * 1000);
    timers.push(setTimeout(() => sendMidi(output, [0x90, note & 0x7f, vel]), delay));
  });
  return function noteOff() {
    for (const timer of timers) clearTimeout(timer);
    for (const note of notes) sendMidi(output, [0x80, note & 0x7f, 0]);
  };
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
}

function buildSegments(container, items, current, onPick) {
  container.replaceChildren();
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.textContent = item.label;
    button.setAttribute("aria-pressed", String(item.value === current));
    button.addEventListener("click", () => onPick(item.value));
    container.appendChild(button);
  }
}

function syncControls() {
  $("key").value = state.key;
  $("scale").value = state.scale;
  $("chord-type").value = state.chordType;
  $("sound").value = state.sound;
  $("voice-leading").checked = state.voiceLeading;
  $("latch").checked = state.latch;
  $("strum-enabled").checked = state.strumEnabled;
  $("strum-speed").value = String(state.strumSpeed);
  $("strum-speed-label").textContent = `${state.strumSpeed} ms`;
  $("bpm").value = String(state.bpm);
  $("volume").value = String(Math.round(state.volume * 100));
  $("volume-label").textContent = String(Math.round(state.volume * 100));
  $("loop").checked = state.loop;
  $("metronome").checked = state.metronome;
  $("midi-base").value = String(state.midiBase);
  $("preset-name").value = state.presetName;
  $("record").setAttribute("aria-pressed", String(state.recording));
  $("play").textContent = state.playing ? "Playing" : "Play";
  buildSegments(
    $("inversion"),
    [0, 1, 2, 3].map((value) => ({ value, label: String(value) })),
    state.inversion,
    (value) => {
      state.inversion = value;
      refreshTheory();
    },
  );
  buildSegments(
    $("spread"),
    [
      { value: 0, label: "Close" },
      { value: 1, label: "Open" },
      { value: 2, label: "Drop 2" },
      { value: 3, label: "Wide" },
    ],
    state.spread,
    (value) => {
      state.spread = value;
      refreshTheory();
    },
  );
  buildSegments(
    $("strum-direction"),
    [
      { value: "up", label: "Up" },
      { value: "down", label: "Down" },
    ],
    state.strumDirection,
    (value) => {
      state.strumDirection = value;
      persist();
    },
  );
  buildSegments(
    $("quantize"),
    [
      { value: 4, label: "1/4" },
      { value: 8, label: "1/8" },
      { value: 16, label: "1/16" },
    ],
    state.quantize,
    (value) => {
      state.quantize = value;
      persist();
    },
  );
}

function refreshTheory() {
  previousNotes = null;
  renderPads();
  persist();
}

function renderPads() {
  const grid = $("pads");
  for (let index = 0; index < PAD_LAYOUT.length; index++) {
    let button = grid.children[index];
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "pad chord-pad";
      button.dataset.pad = String(index);
      button.innerHTML = '<span class="pad-key"></span><span class="pad-roman"></span><span class="pad-symbol"></span>';
      grid.appendChild(button);
    }
    const layout = PAD_LAYOUT[index];
    const info = describeChord({
      key: state.key,
      scale: state.scale,
      chordType: state.chordType,
      inversion: state.inversion,
      spread: state.spread,
      degree: layout.degree,
      octave: layout.octave,
    });
    button.querySelector(".pad-key").textContent = KEY_LABELS[index];
    button.querySelector(".pad-roman").textContent = info.roman;
    button.querySelector(".pad-symbol").textContent = info.symbol;
    button.setAttribute("aria-label", `${info.roman} ${info.symbol}`);
    button.classList.toggle("is-on", held.has(index));
    button.classList.toggle("is-seq", lit.has(index));
    button.setAttribute("aria-pressed", String(held.has(index) || lit.has(index)));
  }
}

function chordLabel(pad) {
  const layout = PAD_LAYOUT[pad];
  return describeChord({
    key: state.key,
    scale: state.scale,
    chordType: state.chordType,
    inversion: state.inversion,
    spread: state.spread,
    degree: layout.degree,
    octave: layout.octave,
  });
}

function notesForPad(pad) {
  const layout = PAD_LAYOUT[pad];
  const notes = buildVoicing(
    {
      ...currentParams(),
      degree: layout.degree,
      octave: layout.octave,
    },
    state.voiceLeading ? previousNotes : null,
  );
  previousNotes = notes;
  return notes;
}

function pressPad(pad, velocity, source) {
  if (pad < 0 || pad >= PAD_LAYOUT.length) return;
  if (state.latch && held.has(pad)) {
    releasePad(pad);
    return;
  }
  if (held.has(pad)) return;
  ensureAudio();
  const notes = notesForPad(pad);
  const plan = strumPlan(notes, currentParams().strum);
  const group = live.play(plan, { sound: state.sound, velocity, duration: null });
  const midiOff = sendChord(notes, Math.round(clamp(velocity, 0.05, 1) * 127), plan.map((hit) => hit.delay));
  held.set(pad, { group, midiOff, source });
  renderPads();
  const info = chordLabel(pad);
  const names = notes.map((note) => noteName(note, state.key)).join(" ");
  setStatus(`${info.symbol} · ${names}`);
  if (state.recording) armRecord(pad, velocity);
}

function releasePad(pad) {
  const item = held.get(pad);
  if (!item) {
    if (state.recording) finishRecord(pad);
    return;
  }
  item.group.release();
  item.midiOff();
  held.delete(pad);
  renderPads();
  if (state.recording) finishRecord(pad);
}

function panic() {
  for (const pad of [...held.keys()]) releasePad(pad);
  live?.panic();
  silenceMidiOutput(activeOutput());
  if (state.playing) {
    state.playing = false;
    stopClock();
  } else {
    for (const timer of clock.timers) clearTimeout(timer);
    clock.timers = [];
    lit.clear();
  }
  renderPads();
  syncControls();
  setStatus("Silent");
}

function armRecord(pad, velocity) {
  const ctx = ensureAudio();
  const beat = Math.max(0, ((ctx.currentTime - record.origin) * state.bpm) / 60);
  record.pending.set(pad, {
    startBeat: quantizeBeat(beat, state.quantize),
    velocity: clamp(velocity, 0.05, 1),
  });
}

function finishRecord(pad) {
  const pending = record.pending.get(pad);
  if (!pending) return;
  record.pending.delete(pad);
  const ctx = audioCtx;
  const beat = Math.max(0, ((ctx.currentTime - record.origin) * state.bpm) / 60);
  const step = 4 / state.quantize;
  let end = quantizeBeat(Math.max(beat, pending.startBeat + step * 0.25), state.quantize);
  let duration = Math.max(step, end - pending.startBeat);
  state.progression.push({
    pad,
    startBeat: pending.startBeat,
    durationBeats: Math.round(duration * 1000) / 1000,
    velocity: pending.velocity,
  });
  state.progression.sort((a, b) => a.startBeat - b.startBeat || a.pad - b.pad);
  renderTimeline();
  persist();
}

function renderTimeline() {
  const host = $("timeline");
  host.replaceChildren();
  if (!state.progression.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Record is empty. Arm record, play the pads, then play it back.";
    host.appendChild(empty);
    return;
  }
  state.progression.forEach((event, index) => {
    const info = chordLabel(event.pad);
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(`${info.symbol} · ${event.durationBeats} beats`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${info.symbol}`);
    remove.addEventListener("click", () => {
      state.progression.splice(index, 1);
      renderTimeline();
      persist();
    });
    chip.appendChild(remove);
    host.appendChild(chip);
  });
}

function stopClock() {
  clock.mode = "idle";
  if (clock.timer) clearTimeout(clock.timer);
  clock.timer = null;
  for (const timer of clock.timers) clearTimeout(timer);
  clock.timers = [];
  lit.clear();
}

function runClock() {
  if (clock.timer) clearTimeout(clock.timer);
  const tick = () => {
    if (clock.mode === "idle" || !audioCtx) return;
    const horizon = audioCtx.currentTime + 0.28;
    const seconds = 60 / state.bpm;
    if (state.metronome) {
      while (clock.origin + clock.nextClick * seconds < horizon && clock.nextClick < 1600) {
        const time = clock.origin + clock.nextClick * seconds;
        if (time >= audioCtx.currentTime - 0.02) {
          const musical = clock.nextClick - clock.countIn;
          live.click(Math.max(time, audioCtx.currentTime), ((musical % 4) + 4) % 4 === 0);
        }
        clock.nextClick += 1;
      }
    }
    if (clock.mode === "play" && clock.plan) {
      if (!state.loop && audioCtx.currentTime > clock.origin + clock.loopBeats * seconds + 0.25 && clock.nextLoop > 0) {
        stopPlay();
        return;
      }
      let guard = 0;
      while (guard < 8) {
        if (!state.loop && clock.nextLoop > 0) break;
        const loopStart = clock.origin + clock.nextLoop * seconds;
        const loopEnd = loopStart + clock.loopBeats * seconds;
        if (loopStart > horizon) break;
        clock.plan.voiced.forEach((chord, index) => {
          const time = loopStart + chord.start;
          const key = `${clock.nextLoop}:${index}`;
          if (clock.scheduled.has(key) || time > horizon || time < audioCtx.currentTime - 0.06) return;
          clock.scheduled.add(key);
          scheduleVoiced(time, chord);
        });
        if (loopEnd > horizon) break;
        clock.nextLoop += clock.loopBeats;
        guard += 1;
      }
    }
    clock.timer = setTimeout(tick, 40);
  };
  tick();
}

function scheduleVoiced(time, chord) {
  live.play(chord.plan, {
    sound: state.sound,
    velocity: chord.velocity,
    duration: chord.duration,
    when: time,
  });
  const wait = Math.max(0, (time - audioCtx.currentTime) * 1000);
  const notes = chord.notes;
  const delays = chord.plan.map((hit) => hit.delay);
  const onTimer = setTimeout(() => {
    const off = sendChord(notes, Math.round(chord.velocity * 127), delays);
    const end = setTimeout(off, (chord.duration + Math.max(0, ...delays)) * 1000);
    clock.timers.push(end);
    if (chord.pad != null) {
      lit.add(chord.pad);
      renderPads();
    }
  }, wait);
  const offLight = setTimeout(() => {
    if (chord.pad != null) {
      lit.delete(chord.pad);
      renderPads();
    }
  }, wait + chord.duration * 1000);
  clock.timers.push(onTimer, offLight);
}

function startRecord() {
  if (state.playing) stopPlay();
  ensureAudio();
  state.recording = true;
  state.progression = [];
  record.pending.clear();
  const seconds = 60 / state.bpm;
  clock.countIn = state.metronome ? 4 : 0;
  clock.origin = audioCtx.currentTime;
  record.origin = clock.origin + clock.countIn * seconds;
  clock.nextClick = 0;
  clock.mode = "record";
  clock.plan = null;
  renderTimeline();
  syncControls();
  setStatus(clock.countIn ? "Count-in, then play" : "Recording");
  runClock();
  persist();
}

function stopRecord() {
  for (const pad of [...record.pending.keys()]) finishRecord(pad);
  state.recording = false;
  if (!state.playing) stopClock();
  syncControls();
  setStatus(state.progression.length ? "Recorded" : "Record is empty");
  persist();
}

function startPlay() {
  if (!state.progression.length) {
    setStatus("Nothing to play yet");
    return;
  }
  if (state.recording) stopRecord();
  ensureAudio();
  panic();
  state.playing = true;
  clock.mode = "play";
  clock.origin = audioCtx.currentTime + 0.08;
  clock.countIn = 0;
  clock.nextClick = 0;
  clock.nextLoop = 0;
  clock.scheduled = new Set();
  clock.loopBeats = loopLengthBeats(state.progression);
  clock.plan = planProgression(state.progression, currentParams());
  syncControls();
  setStatus(state.loop ? "Playing, looped" : "Playing");
  runClock();
}

function stopPlay() {
  state.playing = false;
  stopClock();
  live?.panic();
  silenceMidiOutput(activeOutput());
  renderPads();
  syncControls();
  setStatus("Stopped");
}

function snapshot() {
  return {
    name: state.presetName.trim() || "My progression",
    key: state.key,
    scale: state.scale,
    chordType: state.chordType,
    inversion: state.inversion,
    spread: state.spread,
    voiceLeading: state.voiceLeading,
    strum: {
      enabled: state.strumEnabled,
      speedMs: state.strumSpeed,
      direction: state.strumDirection,
    },
    sound: state.sound,
    bpm: state.bpm,
    loop: state.loop,
    progression: state.progression.map((event) => ({ ...event })),
  };
}

function applyPreset(preset) {
  state.key = KEYS.includes(preset.key) ? preset.key : state.key;
  state.scale = SCALE_IDS.includes(preset.scale) ? preset.scale : state.scale;
  state.chordType = CHORD_TYPES.includes(preset.chordType) ? preset.chordType : state.chordType;
  state.inversion = clamp(preset.inversion ?? 0, 0, 3);
  state.spread = clamp(preset.spread ?? 0, 0, 3);
  state.voiceLeading = Boolean(preset.voiceLeading);
  state.strumEnabled = Boolean(preset.strum?.enabled);
  state.strumSpeed = clamp(preset.strum?.speedMs ?? state.strumSpeed, 0, 80);
  state.strumDirection = preset.strum?.direction === "down" ? "down" : "up";
  state.sound = SOUNDS.includes(preset.sound) ? preset.sound : state.sound;
  state.bpm = clamp(preset.bpm ?? state.bpm, 40, 200);
  if (typeof preset.loop === "boolean") state.loop = preset.loop;
  state.presetName = preset.name || state.presetName;
  state.progression = (preset.progression || [])
    .filter((step) => Number.isInteger(step.pad) && step.pad >= 0 && step.pad < 16)
    .map((step) => ({
      pad: step.pad,
      startBeat: Number(step.startBeat) || 0,
      durationBeats: Math.max(0.25, Number(step.durationBeats) || 1),
      velocity: clamp(Number(step.velocity) || 0.8, 0.05, 1),
    }));
  syncControls();
  refreshTheory();
  renderTimeline();
  setStatus(`Loaded ${state.presetName}`);
}

function renderPresetSelect() {
  const select = $("preset-select");
  const current = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a progression";
  select.appendChild(placeholder);
  const factory = document.createElement("optgroup");
  factory.label = "Factory";
  factoryPresets.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = `factory:${index}`;
    option.textContent = `${preset.name} · ${preset.genre}`;
    factory.appendChild(option);
  });
  select.appendChild(factory);
  const saved = document.createElement("optgroup");
  saved.label = "Saved";
  userPresets.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = `user:${index}`;
    option.textContent = preset.name;
    saved.appendChild(option);
  });
  if (userPresets.length) select.appendChild(saved);
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function loadFactory() {
  factoryPresets = [];
  for (const [id] of FACTORY) {
    const url = new URL(`../presets/${id}.json`, import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Missing preset ${id}`);
    const preset = await response.json();
    const error = validateChordPreset(preset);
    if (error) throw new Error(error);
    factoryPresets.push(preset);
  }
  renderPresetSelect();
}

function exportName(ext) {
  return presetFilename(state.presetName).replace(/\.json$/, `.${ext}`);
}

function mixMono(left, right) {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) * 0.5;
  return mono;
}

async function exportWav() {
  if (!state.progression.length) {
    setStatus("Record something before exporting audio");
    return;
  }
  setStatus("Rendering audio…");
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const rendered = renderProgression(state.progression, { ...currentParams(), sampleRate: 44100, seed: 7 });
    triggerDownload(encodeWav(mixMono(rendered.left, rendered.right), rendered.sampleRate), exportName("wav"), "audio/wav");
    setStatus("WAV exported");
  } catch (error) {
    setStatus(error.message || "Could not render audio");
  }
}

function exportMidi() {
  if (!state.progression.length) {
    setStatus("Record something before exporting MIDI");
    return;
  }
  const plan = planProgression(state.progression, currentParams());
  triggerDownload(
    encodeMidiFile(plan.midiEvents, { bpm: state.bpm, trackName: state.presetName }),
    exportName("mid"),
    "audio/midi",
  );
  setStatus("MIDI exported");
}

function refreshMidiOutputs() {
  const select = $("midi-out");
  const current = state.midiOutId;
  select.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = midiAccess ? "No output" : "Enable MIDI first";
  select.appendChild(none);
  for (const output of midiOutputList(midiAccess)) {
    const option = document.createElement("option");
    option.value = output.id;
    option.textContent = output.name || "MIDI output";
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  else state.midiOutId = "";
}

async function enableMidi() {
  await bindMidiPerformance({
    onAccess(access) {
      midiAccess = access;
      $("midi-enable").textContent = "MIDI on";
      refreshMidiOutputs();
    },
    onNote({ note, velocity }) {
      const pad = note - state.midiBase;
      if (pad >= 0 && pad < 16) pressPad(pad, velocity || 0.8, "midi");
    },
    onNoteOff({ note }) {
      const pad = note - state.midiBase;
      if (pad >= 0 && pad < 16 && !state.latch) releasePad(pad);
    },
    onStatus(status) {
      refreshMidiOutputs();
      const inputs = midiAccess ? [...midiAccess.inputs.values()].length : 0;
      setStatus(status.available ? (inputs ? `MIDI in · ${status.message}` : status.message) : status.message);
    },
  });
}

function bindPads() {
  const grid = $("pads");
  grid.addEventListener("pointerdown", (event) => {
    const pad = event.target.closest(".pad");
    if (!pad) return;
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    const velocity = event.pointerType === "touch" && event.pressure > 0 ? clamp(event.pressure, 0.45, 1) : 0.9;
    pressPad(Number(pad.dataset.pad), velocity, "pointer");
  });
  const release = (event) => {
    const pad = event.target.closest(".pad");
    if (!pad || state.latch) return;
    releasePad(Number(pad.dataset.pad));
  };
  grid.addEventListener("pointerup", release);
  grid.addEventListener("pointercancel", release);
  grid.addEventListener("contextmenu", (event) => event.preventDefault());
}

function bindKeys() {
  const map = {};
  KEY_CODES.forEach((code, index) => {
    map[code] = index;
  });
  bindHeldKeys(map, {
    onDown(pad) {
      pressPad(pad, 0.86, "key");
    },
    onUp(pad) {
      if (!state.latch) releasePad(pad);
    },
  });
  window.addEventListener("keydown", (event) => {
    if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    if (event.code === "Escape") {
      event.preventDefault();
      panic();
      if (state.playing) stopPlay();
    } else if (event.code === "Space") {
      event.preventDefault();
      if (state.playing) stopPlay();
      else startPlay();
    }
  });
}

function readNumber(id, fallback) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function bindControls() {
  $("key").addEventListener("change", () => {
    state.key = $("key").value;
    refreshTheory();
  });
  $("scale").addEventListener("change", () => {
    state.scale = $("scale").value;
    refreshTheory();
  });
  $("chord-type").addEventListener("change", () => {
    state.chordType = $("chord-type").value;
    refreshTheory();
  });
  $("sound").addEventListener("change", () => {
    state.sound = $("sound").value;
    persist();
  });
  $("voice-leading").addEventListener("change", () => {
    state.voiceLeading = $("voice-leading").checked;
    previousNotes = null;
    persist();
  });
  $("latch").addEventListener("change", () => {
    state.latch = $("latch").checked;
    if (!state.latch) {
      for (const pad of [...held.keys()]) releasePad(pad);
    }
    persist();
  });
  $("strum-enabled").addEventListener("change", () => {
    state.strumEnabled = $("strum-enabled").checked;
    persist();
  });
  $("strum-speed").addEventListener("input", () => {
    state.strumSpeed = readNumber("strum-speed", 18);
    $("strum-speed-label").textContent = `${state.strumSpeed} ms`;
    persist();
  });
  $("bpm").addEventListener("change", () => {
    state.bpm = clamp(readNumber("bpm", 100), 40, 200);
    $("bpm").value = String(state.bpm);
    persist();
  });
  $("volume").addEventListener("input", () => {
    state.volume = clamp(readNumber("volume", 85) / 100, 0, 1);
    $("volume-label").textContent = String(Math.round(state.volume * 100));
    live?.setVolume(state.volume);
    persist();
  });
  $("loop").addEventListener("change", () => {
    state.loop = $("loop").checked;
    persist();
  });
  $("metronome").addEventListener("change", () => {
    state.metronome = $("metronome").checked;
    persist();
  });
  $("midi-base").addEventListener("change", () => {
    state.midiBase = Number($("midi-base").value);
    persist();
  });
  $("midi-out").addEventListener("change", () => {
    state.midiOutId = $("midi-out").value;
    persist();
  });
  $("preset-name").addEventListener("change", () => {
    state.presetName = $("preset-name").value.trim() || "My progression";
    persist();
  });
  $("record").addEventListener("click", () => {
    ensureAudio();
    if (state.recording) stopRecord();
    else startRecord();
  });
  $("play").addEventListener("click", () => {
    if (state.playing) stopPlay();
    else startPlay();
  });
  $("stop").addEventListener("click", () => {
    if (state.recording) stopRecord();
    if (state.playing) stopPlay();
    else panic();
  });
  $("clear").addEventListener("click", () => {
    if (state.playing) stopPlay();
    state.progression = [];
    record.pending.clear();
    renderTimeline();
    persist();
    setStatus("Cleared");
  });
  $("panic").addEventListener("click", panic);
  $("midi-enable").addEventListener("click", () => {
    enableMidi().catch((error) => setStatus(error.message || "MIDI permission was blocked"));
  });
  $("preset-select").addEventListener("change", () => {
    const value = $("preset-select").value;
    if (!value) return;
    const [kind, index] = value.split(":");
    const preset = kind === "user" ? userPresets[Number(index)] : factoryPresets[Number(index)];
    if (preset) applyPreset(preset);
  });
  $("preset-save").addEventListener("click", () => {
    state.presetName = $("preset-name").value.trim() || "My progression";
    const preset = snapshot();
    const existing = userPresets.findIndex((item) => item.name === preset.name);
    if (existing >= 0) userPresets[existing] = preset;
    else userPresets.push(preset);
    storeJson(PRESET_KEY, userPresets);
    renderPresetSelect();
    $("preset-select").value = `user:${existing >= 0 ? existing : userPresets.length - 1}`;
    setStatus(`Saved ${preset.name}`);
    persist();
  });
  $("preset-delete").addEventListener("click", () => {
    const value = $("preset-select").value;
    if (!value.startsWith("user:")) {
      setStatus("Pick a saved progression to delete");
      return;
    }
    const index = Number(value.split(":")[1]);
    const [removed] = userPresets.splice(index, 1);
    storeJson(PRESET_KEY, userPresets);
    renderPresetSelect();
    setStatus(removed ? `Deleted ${removed.name}` : "Nothing deleted");
  });
  $("json-out").addEventListener("click", () => {
    state.presetName = $("preset-name").value.trim() || state.presetName;
    downloadTextFile(exportName("json"), JSON.stringify(snapshot(), null, 2));
    setStatus("JSON exported");
  });
  $("json-in").addEventListener("click", async () => {
    try {
      const data = readJsonObject(await pickTextFile());
      const error = validateChordPreset(data);
      if (error) {
        setStatus(error);
        return;
      }
      applyPreset(data);
    } catch (error) {
      if (error?.message !== "No file chosen") setStatus(error.message || "Could not import JSON");
    }
  });
  $("wav").addEventListener("click", exportWav);
  $("midi-file").addEventListener("click", exportMidi);
}

function restore() {
  const saved = loadJson(STATE_KEY, null);
  if (!saved) return;
  Object.assign(state, {
    key: saved.key ?? state.key,
    scale: saved.scale ?? state.scale,
    chordType: saved.chordType ?? state.chordType,
    inversion: saved.inversion ?? state.inversion,
    spread: saved.spread ?? state.spread,
    voiceLeading: Boolean(saved.voiceLeading),
    strumEnabled: Boolean(saved.strumEnabled),
    strumSpeed: saved.strumSpeed ?? state.strumSpeed,
    strumDirection: saved.strumDirection === "down" ? "down" : "up",
    sound: saved.sound ?? state.sound,
    bpm: saved.bpm ?? state.bpm,
    volume: saved.volume ?? state.volume,
    latch: Boolean(saved.latch),
    loop: saved.loop !== false,
    metronome: saved.metronome !== false,
    quantize: saved.quantize ?? state.quantize,
    midiBase: saved.midiBase ?? state.midiBase,
    midiOutId: saved.midiOutId ?? "",
    presetName: saved.presetName ?? state.presetName,
    progression: Array.isArray(saved.progression) ? saved.progression : [],
  });
}

function init() {
  fillSelect($("key"), KEYS.map((key) => ({ value: key, label: key })));
  fillSelect($("scale"), SCALE_IDS.map((id) => ({ value: id, label: SCALE_LABELS[id] || id })));
  fillSelect($("chord-type"), CHORD_TYPES.map((id) => ({ value: id, label: TYPE_LABELS[id] || id })));
  fillSelect($("sound"), SOUNDS.map((id) => ({ value: id, label: SOUND_LABELS[id] || id })));
  userPresets = loadJson(PRESET_KEY, []);
  if (!Array.isArray(userPresets)) userPresets = [];
  restore();
  syncControls();
  renderPads();
  renderTimeline();
  renderPresetSelect();
  bindPads();
  bindKeys();
  bindControls();
  loadFactory().catch((error) => setStatus(error.message || "Could not load presets"));
}

init();
