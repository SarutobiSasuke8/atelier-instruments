import {
  AcidVoice,
  NOTE_NAMES,
  SCALES,
  createEmptyPattern,
  noteLabel,
  patternToMidi,
  randomiseInKey,
  renderAcidPattern,
  resolveParams,
} from "../engine.js";
import { downloadWav, triggerDownload } from "../../../shared/wav-export.js";
import { downloadDocument, loadLibrary, saveLibrary } from "../../../shared/presets.js";
import { bindKeyboardNotes, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { createMidiClockOut } from "../../../shared/midi.js";
import warehouseFloor from "../presets/warehouse-floor.json" with { type: "json" };
import nightBus from "../presets/night-bus.json" with { type: "json" };
import silverRail from "../presets/silver-rail.json" with { type: "json" };
import dryCell from "../presets/dry-cell.json" with { type: "json" };
import neonAlley from "../presets/neon-alley.json" with { type: "json" };

const FACTORY = [warehouseFloor, nightBus, silverRail, dryCell, neonAlley];
const APP_ID = "acid-bass-presets";
const KNOBS = [
  ["cutoff", "Cutoff", 0, 1, 0.001, (v) => v.toFixed(2)],
  ["resonance", "Resonance", 0, 1, 0.001, (v) => v.toFixed(2)],
  ["envMod", "Env mod", 0, 1, 0.001, (v) => v.toFixed(2)],
  ["decay", "Decay", 0, 1, 0.001, (v) => v.toFixed(2)],
  ["accent", "Accent", 0, 1, 0.001, (v) => v.toFixed(2)],
  ["drive", "Drive", 0, 1, 0.001, (v) => v.toFixed(2)],
  ["tempo", "Tempo", 40, 240, 1, (v) => String(Math.round(v))],
  ["swing", "Swing", 0, 1, 0.001, (v) => `${Math.round(v * 100)}%`],
];

const state = {
  params: {},
  patterns: {},
  edit: "A",
  chain: ["A"],
  key: 9,
  scale: "minor",
  name: "Warehouse Floor",
  octave: 0,
  clock: "internal",
  playing: false,
  selected: 0,
};
const heldKeys = new Set();
let audio = null;
let midiAccess = null;
let midiOutputId = "";
let clockOut = null;
let lastHead = "";
let lastMidiNote = null;

const el = {
  knobs: document.querySelector("#knobs"),
  wave: document.querySelector("#wave"),
  patterns: document.querySelector("#patterns"),
  chain: document.querySelector("#chain"),
  steps: document.querySelector("#steps"),
  key: document.querySelector("#key"),
  scale: document.querySelector("#scale"),
  preset: document.querySelector("#preset"),
  presetName: document.querySelector("#preset-name"),
  midiOut: document.querySelector("#midi-out"),
  midiStatus: document.querySelector("#midi-status"),
  status: document.querySelector("#status"),
  playhead: document.querySelector("#playhead"),
  clockReadout: document.querySelector("#clock-readout"),
  play: document.querySelector("#play"),
  stop: document.querySelector("#stop"),
  meter: document.querySelector("#meter"),
  piano: document.querySelector("#piano"),
  octave: document.querySelector("#octave-label"),
  transpose: document.querySelector("#transpose"),
  transposeValue: document.querySelector("#transpose-value"),
};

applyPreset(FACTORY[0], false);
buildKnobs();
buildPatterns();
buildKeyScale();
buildPiano();
renderSteps();
renderChain();
refreshPresetList();
paintWave();
setStatus("Press play, or play the A row on the keyboard.");

document.querySelector("#play").addEventListener("click", () => void play());
document.querySelector("#stop").addEventListener("click", () => stop());
document.querySelector("#add-chain").addEventListener("click", () => {
  if (state.chain.length >= 16) return;
  state.chain.push(state.edit);
  renderChain();
  touchVoice(true);
});
document.querySelector("#clear-chain").addEventListener("click", () => {
  state.chain = [];
  renderChain();
  touchVoice(true);
});
document.querySelector("#clear-pattern").addEventListener("click", () => {
  state.patterns[state.edit] = createEmptyPattern();
  renderSteps();
  touchVoice(true);
  setStatus(`Pattern ${state.edit} cleared.`);
});
document.querySelector("#random").addEventListener("click", () => {
  state.patterns[state.edit] = randomiseInKey({
    root: state.key,
    scale: state.scale,
    density: 0.68,
  });
  renderSteps();
  touchVoice(true);
  setStatus(`Pattern ${state.edit} randomised in ${NOTE_NAMES[state.key]} ${state.scale}.`);
});
document.querySelector("#save-preset").addEventListener("click", saveUserPreset);
document.querySelector("#export-json").addEventListener("click", () => {
  const doc = currentDocument();
  downloadDocument(doc, slug(doc.name));
  setStatus("Preset JSON downloaded.");
});
document.querySelector("#import-json").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!isPreset(data)) throw new Error("not a preset");
    applyPreset(data, true);
    setStatus(`Loaded ${data.name || file.name}.`);
  } catch {
    setStatus("That file is not an Acid Bass Box preset.");
  }
});
document.querySelector("#export-wav").addEventListener("click", exportWav);
document.querySelector("#export-mid").addEventListener("click", exportMidi);
el.preset.addEventListener("change", () => {
  const value = el.preset.value;
  if (value.startsWith("factory:")) applyPreset(FACTORY[Number(value.slice(8))], true);
  else if (value.startsWith("user:")) {
    const list = loadLibrary(APP_ID);
    const found = list[Number(value.slice(5))];
    if (found) applyPreset(found, true);
  }
});
el.key.addEventListener("change", () => {
  state.key = Number(el.key.value);
});
el.scale.addEventListener("change", () => {
  state.scale = el.scale.value;
});
el.transpose.addEventListener("input", () => {
  const value = Number(el.transpose.value);
  el.transposeValue.textContent = value > 0 ? `+${value}` : String(value);
  audio?.voice.setTranspose(value);
});
el.wave.addEventListener("click", (event) => {
  const button = event.target.closest("[data-wave]");
  if (!button) return;
  state.params.waveform = button.dataset.wave;
  paintWave();
  pushParams();
});
document.querySelector("#clock-mode").addEventListener("click", (event) => {
  const button = event.target.closest("[data-clock]");
  if (!button) return;
  void ensureMidi();
  state.clock = button.dataset.clock;
  for (const node of document.querySelectorAll("#clock-mode button")) {
    node.setAttribute("aria-pressed", String(node === button));
  }
  if (state.playing) {
    if (state.clock === "midi") {
      clockOut?.stop();
      audio?.voice.armSlave();
      setStatus("Listening for MIDI clock.");
    } else {
      audio?.voice.sync(program(), state.params);
      audio?.voice.start();
      startClockOut();
    }
  }
  paintClock();
});
el.midiOut.addEventListener("change", () => {
  midiOutputId = el.midiOut.value;
  if (state.playing && state.clock === "internal") startClockOut();
});
el.steps.addEventListener("click", (event) => {
  const column = event.target.closest(".step");
  if (!column) return;
  const index = Number(column.dataset.index);
  state.selected = index;
  const step = state.patterns[state.edit].steps[index];
  if (event.target.closest(".gate")) step.gate = !step.gate;
  else if (event.target.closest("[data-dir]")) nudge(step, Number(event.target.closest("[data-dir]").dataset.dir));
  else if (event.target.closest(".accent")) step.accent = !step.accent;
  else if (event.target.closest(".slide")) step.slide = !step.slide;
  renderSteps();
  touchVoice(true);
});

window.addEventListener("keydown", (event) => {
  if (event.target?.closest?.("input, textarea, select")) return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  const step = state.patterns[state.edit].steps[state.selected];
  if (!step) return;
  nudge(step, event.key === "ArrowUp" ? 1 : -1);
  renderSteps();
  touchVoice(true);
});

bindKeyboardNotes({
  onNoteOn: (semi) => {
    heldKeys.add(semi);
    paintPiano();
    void liveNote(36 + state.octave * 12 + semi, true);
  },
  onNoteOff: (semi) => {
    heldKeys.delete(semi);
    paintPiano();
    void liveNote(36 + state.octave * 12 + semi, false);
  },
  onOctave: (direction) => {
    state.octave = clamp(state.octave + direction, -1, 2);
    paintOctave();
  },
  onTransport: () => {
    if (state.playing) stop();
    else void play();
  },
});

requestAnimationFrame(frame);

function buildKnobs() {
  for (const [id, name, min, max, step, format] of KNOBS) {
    const label = document.createElement("label");
    label.className = "knob";
    const dial = document.createElement("span");
    dial.className = "knob-dial";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(state.params[id]);
    input.setAttribute("aria-label", name);
    const title = document.createElement("span");
    title.className = "knob-name";
    title.textContent = name;
    const value = document.createElement("span");
    value.className = "knob-value";
    const paint = () => {
      const amount = (Number(input.value) - min) / (max - min);
      dial.style.setProperty("--t", String(amount));
      value.textContent = format(Number(input.value));
    };
    input.addEventListener("input", () => {
      state.params[id] = Number(input.value);
      paint();
      pushParams(id === "tempo" || id === "swing");
      if (id === "tempo") paintClock();
    });
    paint();
    label.append(dial, input, title, value);
    el.knobs.append(label);
  }
}

function buildPatterns() {
  for (const id of ["A", "B", "C", "D"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.textContent = id;
    button.dataset.pattern = id;
    button.addEventListener("click", () => {
      state.edit = id;
      state.selected = 0;
      paintPatterns();
      renderSteps();
      if (!state.chain.length) renderChain();
    });
    el.patterns.append(button);
  }
  paintPatterns();
}

function buildKeyScale() {
  NOTE_NAMES.forEach((name, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    el.key.append(option);
  });
  el.key.value = String(state.key);
  for (const name of Object.keys(SCALES)) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    el.scale.append(option);
  }
  el.scale.value = state.scale;
}

function buildPiano() {
  const whites = [0, 2, 4, 5, 7, 9, 11, 12];
  const blacks = [
    [1, 0],
    [3, 1],
    [6, 3],
    [8, 4],
    [10, 5],
  ];
  for (const semi of whites) {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "white";
    key.dataset.semi = String(semi);
    key.setAttribute("aria-label", NOTE_NAMES[semi % 12] + (semi === 12 ? " up" : ""));
    el.piano.append(key);
  }
  for (const [semi, whiteIndex] of blacks) {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "black";
    key.dataset.semi = String(semi);
    key.style.left = `calc(${((whiteIndex + 1) * 100) / whites.length}% - 3.6%)`;
    key.setAttribute("aria-label", NOTE_NAMES[semi]);
    el.piano.append(key);
  }
  el.piano.addEventListener("pointerdown", (event) => {
    const key = event.target.closest("[data-semi]");
    if (!key) return;
    key.setPointerCapture?.(event.pointerId);
    void liveNote(36 + state.octave * 12 + Number(key.dataset.semi), true);
    key.classList.add("is-down");
  });
  const release = (event) => {
    const key = event.target.closest?.("[data-semi]");
    if (!key) return;
    void liveNote(36 + state.octave * 12 + Number(key.dataset.semi), false);
    key.classList.remove("is-down");
  };
  el.piano.addEventListener("pointerup", release);
  el.piano.addEventListener("pointercancel", release);
  paintOctave();
}

function renderSteps() {
  const steps = state.patterns[state.edit].steps;
  el.steps.replaceChildren();
  steps.forEach((step, index) => {
    const column = document.createElement("div");
    column.className = "step";
    column.dataset.index = String(index);
    if (index === state.selected) column.classList.add("is-selected");
    column.innerHTML = `
      <div class="step-index">${String(index + 1).padStart(2, "0")}</div>
      <button type="button" class="gate" aria-pressed="${step.gate}" aria-label="Gate ${index + 1}"></button>
      <div class="pitch">
        <button type="button" class="nudge" data-dir="-1" aria-label="Lower pitch">−</button>
        <span class="note-name">${noteLabel(step)}</span>
        <button type="button" class="nudge" data-dir="1" aria-label="Raise pitch">+</button>
      </div>
      <button type="button" class="flag accent" aria-pressed="${step.accent}">Acc</button>
      <button type="button" class="flag slide" aria-pressed="${step.slide}">Slide</button>
    `;
    el.steps.append(column);
  });
}

function renderChain() {
  el.chain.replaceChildren();
  if (!state.chain.length) {
    const empty = document.createElement("span");
    empty.className = "silkscreen";
    empty.textContent = `Looping ${state.edit} only`;
    el.chain.append(empty);
    return;
  }
  state.chain.forEach((id, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(document.createTextNode(id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.setAttribute("aria-label", `Remove ${id} from chain`);
    remove.addEventListener("click", () => {
      state.chain.splice(index, 1);
      renderChain();
      touchVoice(true);
    });
    chip.append(remove);
    el.chain.append(chip);
  });
}

function paintPatterns() {
  for (const button of el.patterns.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.pattern === state.edit));
  }
}

function paintWave() {
  for (const button of el.wave.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.wave === state.params.waveform));
  }
}

function paintOctave() {
  const root = 2 + state.octave;
  el.octave.textContent = `C${root}`;
}

function paintPiano() {
  for (const key of el.piano.querySelectorAll("[data-semi]")) {
    key.classList.toggle("is-down", heldKeys.has(Number(key.dataset.semi)));
  }
}

function paintClock() {
  const bpm = state.clock === "midi" && audio?.voice.estimatedBpm
    ? Math.round(audio.voice.estimatedBpm)
    : Math.round(state.params.tempo);
  el.clockReadout.textContent = state.clock === "midi" ? `MIDI clock · ${bpm}` : `Internal · ${bpm}`;
}

function refreshKnobs() {
  const inputs = el.knobs.querySelectorAll("input");
  KNOBS.forEach(([id, , min, max, , format], index) => {
    const input = inputs[index];
    input.value = String(state.params[id]);
    const dial = input.parentElement.querySelector(".knob-dial");
    const value = input.parentElement.querySelector(".knob-value");
    dial.style.setProperty("--t", String((Number(input.value) - min) / (max - min)));
    value.textContent = format(Number(input.value));
  });
}

async function ensureAudio() {
  if (audio) return audio;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const voice = new AcidVoice(ctx.sampleRate);
  const node = ctx.createScriptProcessor(512, 0, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0.7;
  node.onaudioprocess = (event) => {
    const out = event.outputBuffer.getChannelData(0);
    const start = ctx.currentTime - out.length / ctx.sampleRate;
    voice.process(out, start);
  };
  node.connect(gain);
  gain.connect(ctx.destination);
  voice.sync(program(), state.params);
  audio = { ctx, voice, node, gain };
  clockOut = createMidiClockOut((bytes) => midiSend(bytes));
  return audio;
}

async function play() {
  void ensureMidi();
  const engine = await ensureAudio();
  if (engine.ctx.state === "suspended") await engine.ctx.resume();
  engine.voice.sync(program(), state.params);
  engine.voice.setTranspose(Number(el.transpose.value) || 0);
  state.playing = true;
  el.play.setAttribute("aria-pressed", "true");
  if (state.clock === "midi") {
    engine.voice.armSlave();
    clockOut?.stop();
    setStatus("Armed. Waiting for a MIDI start and clock.");
  } else {
    engine.voice.start();
    startClockOut();
    setStatus("Playing.");
  }
  paintClock();
}

function stop() {
  state.playing = false;
  audio?.voice.stop();
  clockOut?.stop();
  noteOutOff();
  el.play.setAttribute("aria-pressed", "false");
  el.playhead.textContent = "Stopped";
  setStatus("Stopped.");
  paintClock();
}

function startClockOut() {
  if (!clockOut || !audio) return;
  clockOut.stop();
  if (state.clock !== "internal" || !el.midiOut.value) return;
  clockOut.start(audio.ctx, () => state.params.tempo);
}

function pushParams(rebuild) {
  if (!audio) return;
  audio.voice.params = resolveParams({ ...state.params, sampleRate: audio.voice.sampleRate });
  if (rebuild) {
    audio.voice.timelineKey = "";
    audio.voice.rebuildTimeline();
  }
}

function touchVoice() {
  if (!audio) return;
  const head = audio.voice.patternSample;
  const index = audio.voice.stepIndex;
  audio.voice.sync(program(), state.params);
  audio.voice.patternSample = Math.min(head, Math.max(0, audio.voice.loopSamples - 1));
  audio.voice.stepIndex = Math.min(index, audio.voice.steps.length - 1);
}

function program() {
  return { patterns: state.patterns, chain: state.chain, edit: state.edit };
}

async function liveNote(midiNote, down) {
  const engine = await ensureAudio();
  if (engine.ctx.state === "suspended") await engine.ctx.resume();
  if (!down) {
    if (state.playing) {
      if (heldKeys.size === 0) engine.voice.setTranspose(Number(el.transpose.value) || 0);
    } else engine.voice.noteOff(midiNote);
    return;
  }
  if (state.playing) {
    const latest = [...heldKeys].pop();
    const midiValue = latest == null ? midiNote : 36 + state.octave * 12 + latest;
    engine.voice.setTranspose((Number(el.transpose.value) || 0) + (midiValue - 36));
  } else {
    engine.voice.noteOn(midiNote);
  }
}

function frame() {
  if (audio && state.playing) {
    const head = audio.voice.playhead;
    const key = `${head.patternId}:${head.local}`;
    if (key !== lastHead && head.local >= 0) {
      lastHead = key;
      el.playhead.textContent = `${head.patternId} · ${String(head.local + 1).padStart(2, "0")}`;
      for (const column of el.steps.children) {
        const on = head.patternId === state.edit && Number(column.dataset.index) === head.local;
        column.classList.toggle("is-current", on);
      }
      for (const button of el.patterns.querySelectorAll("button")) {
        button.classList.toggle("is-live", button.dataset.pattern === head.patternId);
      }
      emitStep(head);
    }
    const peak = audio.voice.peak;
    const lights = el.meter.children;
    for (let i = 0; i < lights.length; i++) {
      lights[i].classList.toggle("is-on", peak > (i + 1) / (lights.length + 0.5));
    }
    if (state.clock === "midi" && audio.voice.estimatedBpm) paintClock();
  }
  requestAnimationFrame(frame);
}

function emitStep(head) {
  if (!midiOutputId) return;
  const steps = flatSteps();
  const step = steps[head.step];
  noteOutOff();
  if (!step?.gate) return;
  const note = clamp((state.params.rootMidi || 36) + step.octave * 12 + step.note + (audio?.voice.transpose || 0), 0, 127);
  const velocity = step.accent ? 112 : 84;
  midiSend([0x90, note, velocity]);
  lastMidiNote = note;
}

function noteOutOff() {
  if (lastMidiNote == null) return;
  midiSend([0x80, lastMidiNote, 0]);
  lastMidiNote = null;
}

function midiSend(bytes) {
  if (!midiAccess || !midiOutputId) return;
  const port = midiAccess.outputs.get(midiOutputId);
  if (!port) return;
  try {
    port.send(bytes);
  } catch {
    /* port closed */
  }
}

function flatSteps() {
  const chain = state.chain.length ? state.chain : [state.edit];
  const steps = [];
  for (const id of chain) steps.push(...state.patterns[id].steps);
  return steps;
}

let midiPromise = null;
function ensureMidi() {
  if (midiPromise) return midiPromise;
  midiPromise = bindMidiPerformance({
    onAccess: (access) => {
      midiAccess = access;
      const previous = midiOutputId;
      el.midiOut.replaceChildren(new Option("No device", ""));
      for (const port of access.outputs.values()) {
        el.midiOut.append(new Option(port.name || "MIDI out", port.id));
      }
      if ([...el.midiOut.options].some((option) => option.value === previous)) el.midiOut.value = previous;
      midiOutputId = el.midiOut.value;
    },
    onStatus: (info) => {
      el.midiStatus.textContent = info.message || (info.available ? "MIDI ready" : "MIDI unavailable");
    },
    onNote: ({ note }) => void liveNote(note, true),
    onNoteOff: ({ note }) => void liveNote(note, false),
    onStart: () => {
      if (state.clock !== "midi") return;
      void play();
    },
    onContinue: () => {
      if (state.clock !== "midi") return;
      void play();
    },
    onStop: () => {
      if (state.clock === "midi") stop();
    },
    onClock: () => {
      if (!audio || state.clock !== "midi" || !state.playing) return;
      audio.voice.schedule(audio.ctx.currentTime, "clock");
    },
  }).catch(() => {
    midiPromise = null;
  });
  return midiPromise;
}

async function setupMidi() {
  return ensureMidi();
}

function applyPreset(raw, announce) {
  const data = clone(raw);
  const params = resolveParams(data.params || {});
  state.params = {
    waveform: params.waveform,
    cutoff: params.cutoff,
    resonance: params.resonance,
    envMod: params.envMod,
    decay: params.decay,
    accent: params.accent,
    drive: params.drive,
    tempo: params.tempo,
    swing: params.swing,
    rootMidi: 36,
  };
  state.patterns = {
    A: data.patterns?.A || createEmptyPattern(),
    B: data.patterns?.B || createEmptyPattern(),
    C: data.patterns?.C || createEmptyPattern(),
    D: data.patterns?.D || createEmptyPattern(),
  };
  for (const id of ["A", "B", "C", "D"]) {
    if (!state.patterns[id].steps) state.patterns[id] = { steps: state.patterns[id] };
  }
  state.chain = Array.isArray(data.chain) ? data.chain.filter((id) => "ABCD".includes(id)) : ["A"];
  state.edit = "A";
  state.key = Number.isFinite(data.key) ? data.key : 0;
  state.scale = SCALES[data.scale] ? data.scale : "minor";
  state.name = data.name || "Untitled";
  state.selected = 0;
  if (el.knobs.childElementCount) refreshKnobs();
  if (el.steps) renderSteps();
  if (el.chain) renderChain();
  if (el.key?.options.length) el.key.value = String(state.key);
  if (el.scale?.options.length) el.scale.value = state.scale;
  el.presetName.value = state.name;
  paintWave();
  paintPatterns();
  paintClock();
  touchVoice(true);
  if (announce) setStatus(`Loaded ${state.name}.`);
}

function currentDocument() {
  return {
    name: el.presetName.value.trim() || state.name || "Untitled",
    params: {
      waveform: state.params.waveform,
      cutoff: state.params.cutoff,
      resonance: state.params.resonance,
      envMod: state.params.envMod,
      decay: state.params.decay,
      accent: state.params.accent,
      drive: state.params.drive,
      tempo: state.params.tempo,
      swing: state.params.swing,
    },
    key: state.key,
    scale: state.scale,
    chain: state.chain.slice(),
    patterns: clone(state.patterns),
  };
}

function saveUserPreset() {
  const doc = currentDocument();
  const library = loadLibrary(APP_ID);
  const index = library.findIndex((preset) => preset.name === doc.name);
  if (index >= 0) library[index] = doc;
  else library.push(doc);
  saveLibrary(APP_ID, library);
  state.name = doc.name;
  refreshPresetList();
  el.preset.value = `user:${index >= 0 ? index : library.length - 1}`;
  setStatus(`Saved “${doc.name}” in this browser.`);
}

function refreshPresetList() {
  const current = el.preset.value;
  el.preset.replaceChildren();
  FACTORY.forEach((preset, index) => {
    el.preset.append(new Option(preset.name, `factory:${index}`));
  });
  const library = loadLibrary(APP_ID);
  library.forEach((preset, index) => {
    el.preset.append(new Option(preset.name || `User ${index + 1}`, `user:${index}`));
  });
  if ([...el.preset.options].some((option) => option.value === current)) el.preset.value = current;
}

function exportWav() {
  setStatus("Rendering WAV…");
  const doc = currentDocument();
  const rendered = renderAcidPattern(
    { patterns: doc.patterns, chain: doc.chain.length ? doc.chain : [state.edit] },
    { ...doc.params, cycles: 4, sampleRate: 44100 },
  );
  downloadWav(rendered.samples, rendered.sampleRate, `${slug(doc.name)}.wav`);
  setStatus("WAV downloaded.");
}

function exportMidi() {
  const doc = currentDocument();
  const bytes = patternToMidi(
    { patterns: doc.patterns, chain: doc.chain.length ? doc.chain : [state.edit] },
    { ...doc.params, cycles: 4, rootMidi: 36 },
  );
  triggerDownload(bytes, `${slug(doc.name)}.mid`, "audio/midi");
  setStatus("MIDI file downloaded.");
}

function isPreset(data) {
  return Boolean(data && data.patterns && (data.patterns.A?.steps || Array.isArray(data.patterns.A)));
}

function nudge(step, direction) {
  let midi = step.octave * 12 + step.note + direction;
  midi = clamp(midi, 0, 35);
  step.octave = Math.floor(midi / 12);
  step.note = midi % 12;
  step.gate = true;
}

function setStatus(text) {
  el.status.textContent = text;
}

function slug(name) {
  return String(name || "acid-bass-box").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "acid-bass-box";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}


let optionalPedals;
document.getElementById('acid-pedals').addEventListener('click', async () => {
  const dialog = document.getElementById('acid-pedal-dialog');
  const host = document.getElementById('acid-pedal-host');
  if (!dialog.open) dialog.showModal();
  if (optionalPedals) return;
  try {
    const audio = await ensureAudio();
    const { mountPedalboard } = await import('../../../shared/pedalboard/board.js');
    optionalPedals = await mountPedalboard({ host, context: audio.ctx, input: audio.gain });
    audio.gain.disconnect(audio.ctx.destination);
  } catch (error) {
    host.textContent = error.message;
  }
});
