/* Atelier Instruments — MIT License. Panel wiring for the arpeggiator lab. */
import { renderArp, stepStartBeat } from "../engine.js";
import { renderVoices } from "../synth-offline.js";
import { createPlayer } from "./player.js";
import { downloadWav, triggerDownload } from "../../../shared/wav-export.js";
import { encodeMidi, listenMidi, noteName, openMidi, supportsMidi } from "../../../shared/midi.js";
import { loadJson, readJsonObject, saveJson, writeJsonObject } from "../../../shared/presets.js";
import { KEY_OFFSETS, offsetFromKey, textField } from "./keys.js";

const MODES = [
  ["up", "Up"],
  ["down", "Down"],
  ["up-down", "Up Down"],
  ["random", "Random"],
  ["chord", "Chord"],
  ["as-played", "As Played"],
];
const WAVES = [
  ["saw", "Saw"],
  ["square", "Square"],
  ["triangle", "Triangle"],
  ["sine", "Sine"],
];
const QUALITIES = [
  ["Major", [0, 4, 7]],
  ["Minor", [0, 3, 7]],
  ["7", [0, 4, 7, 10]],
  ["Maj7", [0, 4, 7, 11]],
  ["Min7", [0, 3, 7, 10]],
  ["Sus", [0, 5, 7]],
  ["Dim", [0, 3, 6]],
  ["Add9", [0, 4, 7, 14]],
];
const LETTERS = Object.entries(KEY_OFFSETS)
  .sort((a, b) => a[1] - b[1])
  .map(([key]) => key.toUpperCase());
const BLACK = new Set([1, 3, 6, 8, 10]);
const SESSION_KEY = "atelier.arp-lab.session";
const BANK_KEY = "atelier.arp-lab.bank";
const player = createPlayer();

const held = { key: new Set(), pointer: new Set(), midi: new Set() };

const state = {
  bpm: 112,
  latch: true,
  walk: false,
  base: 48,
  armed: 0,
  steps: 16,
  probability: Array(16).fill(1),
  ratchets: Array(16).fill(1),
  accents: Array(16).fill(false),
  mode: "up",
  rate: 4,
  gate: 0.65,
  octaves: 1,
  swing: 0,
  seed: 1,
  waveform: "saw",
  cutoff: 1800,
  resonance: 0.25,
  attack: 0.008,
  decay: 0.16,
  sustain: 0.35,
  release: 0.2,
  gain: 0.7,
  bars: 4,
  channel: 1,
  bus: true,
  midiIn: false,
  outputId: "",
  name: "Copper Lattice",
  slots: [[], [], [], []],
  order: [],
  sounding: [],
  padSticky: false,
  factory: [],
  userPresets: [],
  currentStep: -1,
  playBeat: 0,
};

const $ = (id) => document.getElementById(id);
let midiAccess = null;
let saveTimer = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function anyHeld() {
  return held.key.size + held.pointer.size + held.midi.size > 0;
}

function isHeld(note) {
  return held.key.has(note) || held.pointer.has(note) || held.midi.has(note);
}

function setStatus(text) {
  $("status").textContent = text;
}

function arpParams() {
  return {
    mode: state.mode,
    rate: state.rate,
    gate: state.gate,
    octaves: state.octaves,
    swing: state.swing,
    steps: state.steps,
    probability: state.probability.slice(),
    ratchets: state.ratchets.slice(),
    accents: state.accents.map((accent) => (accent ? 1 : 0)),
    velocity: 100,
    accentVelocity: 124,
    seed: state.seed | 0,
    length: 4,
  };
}

function synthParams() {
  return {
    waveform: state.waveform,
    cutoff: state.cutoff,
    resonance: state.resonance,
    attack: state.attack,
    decay: state.decay,
    sustain: state.sustain,
    release: state.release,
    gain: state.gain,
    bpm: state.bpm,
  };
}

function handChord() {
  if (anyHeld()) return state.order.filter((note) => isHeld(note));
  return state.sounding.slice();
}

function filledSlots() {
  const out = [];
  state.slots.forEach((notes, slot) => {
    if (notes?.length) out.push({ slot, notes });
  });
  return out;
}

function notesAt(beat) {
  if (anyHeld()) return handChord();
  if (state.walk) {
    const filled = filledSlots();
    if (filled.length) {
      const index = Math.floor(Math.max(0, beat) / 4) % filled.length;
      return filled[index].notes;
    }
  }
  return state.sounding;
}

function phraseAt(beat) {
  if (anyHeld()) return "keys";
  if (state.walk) {
    const filled = filledSlots();
    if (filled.length) return `slot-${Math.floor(Math.max(0, beat) / 4) % filled.length}`;
  }
  return "hand";
}

function snapshot() {
  return {
    bpm: clamp(state.bpm, 40, 240),
    arp: arpParams(),
    synth: synthParams(),
    midi: { output: Boolean(state.outputId), channel: state.channel, bus: state.bus },
    notesAt,
    phraseAt,
  };
}

function displayNotes() {
  if (player.playing && !anyHeld()) return notesAt(state.playBeat || 0);
  return handChord();
}

function formatNotes(notes) {
  if (!notes?.length) return "Silence";
  return notes.map((note) => noteName(note)).join(" · ");
}

function slug(name) {
  return String(name || "arp-lab")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "arp-lab";
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJson(SESSION_KEY, collectPreset()), 180);
}

function noteOn(note, source) {
  const set = held[source];
  if (!set || set.has(note)) return;
  if (!anyHeld() || state.padSticky) {
    state.order = [];
    state.padSticky = false;
  }
  set.add(note);
  if (!state.order.includes(note)) state.order.push(note);
  state.sounding = state.latch ? state.order.slice() : state.order.filter((item) => isHeld(item));
  paintHarmony();
  scheduleSave();
}

function noteOff(note, source) {
  const set = held[source];
  if (!set) return;
  set.delete(note);
  if (!state.latch && !isHeld(note)) {
    state.order = state.order.filter((item) => item !== note);
    state.sounding = state.order.filter((item) => isHeld(item));
  }
  paintHarmony();
}

function setChord(notes, preview) {
  held.key.clear();
  held.pointer.clear();
  held.midi.clear();
  state.order = notes.slice();
  state.sounding = notes.slice();
  state.padSticky = true;
  if (state.walk) {
    state.walk = false;
    $("walk").setAttribute("aria-pressed", "false");
  }
  paintHarmony();
  scheduleSave();
  if (preview) player.preview(notes, snapshot);
}

function resizeLanes(count, source = {}) {
  const size = clamp(count | 0, 1, 32);
  const listFrom = (value, fallback) => {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return Array(size).fill(value === 0 ? 0 : value || fallback);
  };
  const take = (value, fallback, map) => {
    const list = listFrom(value, fallback);
    return Array.from({ length: size }, (_, index) => (index < list.length ? map(list[index]) : fallback));
  };
  state.steps = size;
  state.probability = take(source.probability ?? state.probability, 1, (value) => clamp(Number(value) || 0, 0, 1));
  state.ratchets = take(source.ratchets ?? state.ratchets, 1, (value) => clamp(Math.round(Number(value) || 1), 1, 8));
  state.accents = take(source.accents ?? state.accents, false, (value) => value === true || Number(value) >= 1);
  const choice = [8, 16, 32].includes(size) ? size : 16;
  $("step-count").value = String(choice);
  buildSteps();
}

function paintProb(el, value) {
  const fill = el.querySelector(".prob-fill");
  fill.style.height = `${Math.round(value * 100)}%`;
  el.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  el.setAttribute("aria-valuetext", `${Math.round(value * 100)} percent`);
}

function buildSteps() {
  const root = $("steps");
  root.replaceChildren();
  for (let index = 0; index < state.steps; index++) {
    const column = document.createElement("div");
    column.className = "step";
    column.dataset.index = String(index);

    const label = document.createElement("span");
    label.className = "index";
    label.textContent = String(index + 1).padStart(2, "0");

    const lamp = document.createElement("button");
    lamp.type = "button";
    lamp.className = "lamp";
    lamp.innerHTML = "<i></i>";
    lamp.setAttribute("aria-label", `Accent step ${index + 1}`);
    lamp.addEventListener("click", () => {
      state.accents[index] = !state.accents[index];
      lamp.classList.toggle("is-on", state.accents[index]);
      lamp.setAttribute("aria-pressed", state.accents[index] ? "true" : "false");
      scheduleSave();
    });

    const prob = document.createElement("div");
    prob.className = "prob";
    prob.tabIndex = 0;
    prob.setAttribute("role", "slider");
    prob.setAttribute("aria-label", `Probability step ${index + 1}`);
    prob.setAttribute("aria-valuemin", "0");
    prob.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.className = "prob-fill";
    prob.append(fill);
    const writeProb = (value) => {
      state.probability[index] = clamp(Math.round(value * 20) / 20, 0, 1);
      paintProb(prob, state.probability[index]);
      scheduleSave();
    };
    const fromPointer = (event) => {
      const rect = prob.getBoundingClientRect();
      const ratio = 1 - (event.clientY - rect.top) / rect.height;
      writeProb(ratio);
    };
    prob.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      prob.setPointerCapture(event.pointerId);
      fromPointer(event);
      const move = (ev) => fromPointer(ev);
      const up = () => {
        prob.removeEventListener("pointermove", move);
        prob.removeEventListener("pointerup", up);
      };
      prob.addEventListener("pointermove", move);
      prob.addEventListener("pointerup", up);
    });
    prob.addEventListener("keydown", (event) => {
      const current = state.probability[index];
      if (event.key === "ArrowUp" || event.key === "ArrowRight") writeProb(current + 0.05);
      else if (event.key === "ArrowDown" || event.key === "ArrowLeft") writeProb(current - 0.05);
      else if (event.key === "Home") writeProb(0);
      else if (event.key === "End") writeProb(1);
      else return;
      event.preventDefault();
    });

    const ratchet = document.createElement("button");
    ratchet.type = "button";
    ratchet.className = "ratchet";
    ratchet.addEventListener("click", () => {
      const cycle = [1, 2, 3, 4];
      const next = cycle[(cycle.indexOf(state.ratchets[index]) + 1) % cycle.length] || 1;
      state.ratchets[index] = next;
      ratchet.textContent = `${next}×`;
      ratchet.setAttribute("aria-label", `Ratchet step ${index + 1}: ${next}`);
      scheduleSave();
    });

    column.append(label, lamp, prob, ratchet);
    root.append(column);
  }
  paintSteps();
}

function paintSteps() {
  const columns = $("steps").children;
  const lane = state.currentStep < 0 ? -1 : ((state.currentStep % state.steps) + state.steps) % state.steps;
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    column.classList.toggle("is-current", index === lane);
    const lamp = column.querySelector(".lamp");
    lamp.classList.toggle("is-on", Boolean(state.accents[index]));
    lamp.setAttribute("aria-pressed", state.accents[index] ? "true" : "false");
    paintProb(column.querySelector(".prob"), state.probability[index] ?? 1);
    const count = state.ratchets[index] || 1;
    const ratchet = column.querySelector(".ratchet");
    ratchet.textContent = `${count}×`;
    ratchet.setAttribute("aria-label", `Ratchet step ${index + 1}: ${count}`);
  }
  $("step-readout").textContent = lane < 0 ? "—" : String(lane + 1).padStart(2, "0");
}

function buildKeyboard() {
  const root = $("keys");
  root.replaceChildren();
  const span = 25;
  let whites = 0;
  for (let i = 0; i < span; i++) if (!BLACK.has(i % 12)) whites += 1;
  const whiteBefore = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  for (let i = 0; i < span; i++) {
    const note = state.base + i;
    const black = BLACK.has(i % 12);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pkey ${black ? "black" : "white"}`;
    button.dataset.note = String(note);
    button.setAttribute("aria-label", noteName(note));
    const name = document.createElement("span");
    name.className = "key-name";
    name.textContent = noteName(note).replace(/\d/, "");
    button.append(name);
    if (i < LETTERS.length) {
      const letter = document.createElement("span");
      letter.className = "key-letter";
      letter.textContent = LETTERS[i];
      button.append(letter);
    }
    if (black) {
      const octave = Math.floor(i / 12);
      const boundary = whiteBefore[i % 12] + octave * 7 + 1;
      button.style.left = `${(boundary / whites) * 100}%`;
    }
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      noteOn(note, "pointer");
    });
    button.addEventListener("pointerenter", (event) => {
      if (event.buttons & 1) noteOn(note, "pointer");
    });
    root.append(button);
  }
  $("oct-label").textContent = `${noteName(state.base)} – ${noteName(state.base + 24)}`;
  paintHarmony();
}

function paintHarmony() {
  const notes = displayNotes();
  $("chord-readout").textContent = formatNotes(notes);
  const on = new Set(notes);
  for (const key of $("keys").querySelectorAll(".pkey")) {
    const active = on.has(Number(key.dataset.note));
    key.classList.toggle("is-on", active);
    key.setAttribute("aria-pressed", active ? "true" : "false");
  }
  const live = player.playing && state.walk ? activeSlot() : -1;
  const buttons = $("slots").querySelectorAll("button");
  buttons.forEach((button, index) => {
    const chord = state.slots[index] || [];
    button.classList.toggle("is-armed", index === state.armed);
    button.classList.toggle("is-live", index === live);
    button.innerHTML = `<small>Slot ${index + 1}${index === live ? " · live" : ""}</small>${chord.length ? formatNotes(chord) : "Empty"}`;
  });
}

function activeSlot() {
  const filled = filledSlots();
  if (!filled.length) return -1;
  const index = Math.floor(Math.max(0, state.playBeat) / 4) % filled.length;
  return filled[index].slot;
}

function buttonRow(root, items, current, onPick) {
  root.replaceChildren();
  for (const [id, label] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.textContent = label;
    button.dataset.value = String(id);
    button.setAttribute("aria-pressed", String(id) === String(current) ? "true" : "false");
    button.addEventListener("click", () => onPick(id, button));
    root.append(button);
  }
}

function markPressed(root, value) {
  for (const button of root.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.value === String(value) ? "true" : "false");
  }
}

function syncNumbers() {
  $("bpm").value = String(state.bpm);
  $("gate").value = String(state.gate);
  $("swing").value = String(state.swing);
  $("seed").value = String(state.seed);
  $("rate").value = String(state.rate);
  $("cutoff").value = String(state.cutoff);
  $("resonance").value = String(state.resonance);
  $("attack").value = String(state.attack);
  $("decay").value = String(state.decay);
  $("sustain").value = String(state.sustain);
  $("release").value = String(state.release);
  $("gain").value = String(state.gain);
  $("bars").value = String(state.bars);
  $("midi-channel").value = String(state.channel);
  $("preset-name").value = state.name;
  $("latch").setAttribute("aria-pressed", state.latch ? "true" : "false");
  $("walk").setAttribute("aria-pressed", state.walk ? "true" : "false");
  $("bus").setAttribute("aria-pressed", state.bus ? "true" : "false");
  $("midi-in").setAttribute("aria-pressed", state.midiIn ? "true" : "false");
  paintFaders();
  markPressed($("modes"), state.mode);
  markPressed($("waves"), state.waveform);
  markPressed($("octaves"), state.octaves);
  const option = [...$("preset-select").options].find((item) => item.value === state.name);
  if (option) $("preset-select").value = state.name;
}

function paintFaders() {
  $("gate-val").textContent = `${Math.round(state.gate * 100)}%`;
  $("swing-val").textContent = `${Math.round(state.swing * 100)}%`;
  $("cutoff-val").textContent = `${Math.round(state.cutoff)} Hz`;
  $("res-val").textContent = `${Math.round(state.resonance * 100)}%`;
  $("attack-val").textContent = `${Math.round(state.attack * 1000)} ms`;
  $("decay-val").textContent = `${Math.round(state.decay * 1000)} ms`;
  $("sustain-val").textContent = `${Math.round(state.sustain * 100)}%`;
  $("release-val").textContent = `${Math.round(state.release * 1000)} ms`;
  $("gain-val").textContent = `${Math.round(state.gain * 100)}%`;
}

function collectPreset() {
  return {
    name: state.name,
    bpm: state.bpm,
    walk: state.walk,
    latch: state.latch,
    bars: state.bars,
    base: state.base,
    sounding: state.sounding.slice(),
    slots: state.slots.map((notes) => notes.slice()),
    arp: arpParams(),
    synth: synthParams(),
  };
}

function applyPreset(preset, { remember = true } = {}) {
  if (!preset || typeof preset !== "object") return;
  state.name = String(preset.name || "Untitled").slice(0, 48);
  state.bpm = clamp(Number(preset.bpm) || 112, 40, 240);
  state.walk = Boolean(preset.walk);
  if (typeof preset.latch === "boolean") state.latch = preset.latch;
  state.bars = clamp(Number(preset.bars) || 4, 1, 16);
  state.base = clamp(Number(preset.base) || 48, 24, 84);
  const arp = preset.arp || {};
  state.mode = MODES.some(([id]) => id === arp.mode) ? arp.mode : "up";
  state.rate = Number(arp.rate) || 4;
  state.gate = clamp(Number(arp.gate ?? 0.65), 0.05, 1);
  state.octaves = clamp(Number(arp.octaves) || 1, 1, 4);
  state.swing = clamp(Number(arp.swing) || 0, 0, 1);
  state.seed = clamp(Number(arp.seed) || 1, 1, 999999);
  const synth = preset.synth || {};
  state.waveform = WAVES.some(([id]) => id === synth.waveform) ? synth.waveform : "saw";
  state.cutoff = clamp(Number(synth.cutoff) || 1800, 80, 8000);
  state.resonance = clamp(Number(synth.resonance) || 0, 0, 0.9);
  state.attack = clamp(Number(synth.attack) || 0.008, 0.001, 0.4);
  state.decay = clamp(Number(synth.decay) || 0.16, 0.01, 1.2);
  state.sustain = clamp(Number(synth.sustain ?? 0.35), 0, 1);
  state.release = clamp(Number(synth.release) || 0.2, 0.02, 1.5);
  state.gain = clamp(Number(synth.gain ?? 0.7), 0, 1);
  const slots = Array.isArray(preset.slots) ? preset.slots : [];
  state.slots = [0, 1, 2, 3].map((index) => {
    const slot = slots[index];
    const notes = Array.isArray(slot) ? slot : slot?.notes;
    return Array.isArray(notes) ? notes.map((note) => note | 0).filter((note) => note >= 0 && note <= 127) : [];
  });
  const sounding = Array.isArray(preset.sounding) ? preset.sounding : state.slots.find((notes) => notes.length) || [];
  state.sounding = sounding.map((note) => note | 0);
  state.order = state.sounding.slice();
  state.padSticky = state.sounding.length > 0;
  resizeLanes(Number(arp.steps) || state.probability.length || 16, arp);
  buildKeyboard();
  syncNumbers();
  paintHarmony();
  if (remember) scheduleSave();
}

function fillPresetSelect() {
  const select = $("preset-select");
  select.replaceChildren();
  const factoryGroup = document.createElement("optgroup");
  factoryGroup.label = "Factory";
  for (const preset of state.factory) {
    const option = document.createElement("option");
    option.value = preset.name;
    option.textContent = preset.name;
    factoryGroup.append(option);
  }
  select.append(factoryGroup);
  if (state.userPresets.length) {
    const userGroup = document.createElement("optgroup");
    userGroup.label = "Stored";
    for (const preset of state.userPresets) {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = preset.name;
      userGroup.append(option);
    }
    select.append(userGroup);
  }
}

function findPreset(name) {
  return state.userPresets.find((preset) => preset.name === name) || state.factory.find((preset) => preset.name === name);
}

function chordsForExport() {
  const bars = clamp(state.bars, 1, 16);
  if (state.walk) {
    const filled = filledSlots();
    if (filled.length) {
      return filled.length
        ? Array.from({ length: bars }, (_, index) => ({
            notes: filled[index % filled.length].notes,
            start: index * 4,
            length: 4,
          }))
        : [];
    }
  }
  return [{ notes: handChord(), start: 0, length: bars * 4 }];
}

function paintTransport() {
  $("play").textContent = player.playing ? "Playing" : "Play";
  $("play").setAttribute("aria-pressed", player.playing ? "true" : "false");
}

async function togglePlay() {
  if (player.playing) {
    player.stop();
    paintTransport();
    paintHarmony();
    setStatus("Stopped.");
    return;
  }
  const chord = notesAt(0);
  if (!chord.length && !filledSlots().length) {
    setStatus("Play a chord, pick a quality, or capture a slot first.");
    return;
  }
  try {
    await player.start(snapshot);
    paintTransport();
    setStatus(state.walk ? "Walking the captured slots." : "Arpeggio running.");
  } catch {
    setStatus("This browser blocked audio. Click Play again.");
  }
}

function bindStatic() {
  buttonRow($("modes"), MODES, state.mode, (mode) => {
    state.mode = mode;
    markPressed($("modes"), mode);
    scheduleSave();
  });
  buttonRow($("waves"), WAVES, state.waveform, (waveform) => {
    state.waveform = waveform;
    markPressed($("waves"), waveform);
    scheduleSave();
  });
  buttonRow(
    $("octaves"),
    [1, 2, 3, 4].map((n) => [n, n === 1 ? "1 oct" : `${n} oct`]),
    state.octaves,
    (octaves) => {
      state.octaves = Number(octaves);
      markPressed($("octaves"), state.octaves);
      scheduleSave();
    },
  );
  $("qualities").replaceChildren();
  for (const [label, intervals] of QUALITIES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.textContent = label;
    button.addEventListener("click", () => {
      setChord(intervals.map((interval) => state.base + interval), true);
      setStatus(`${label} from ${noteName(state.base)}.`);
    });
    $("qualities").append(button);
  }
  $("slots").replaceChildren();
  for (let index = 0; index < 4; index++) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.addEventListener("click", () => {
      state.armed = index;
      if (!state.walk && state.slots[index].length) setChord(state.slots[index], !player.playing);
      else paintHarmony();
    });
    $("slots").append(button);
  }

  $("play").addEventListener("click", togglePlay);
  $("stop").addEventListener("click", () => {
    player.stop();
    paintTransport();
    paintSteps();
    paintHarmony();
    setStatus("Stopped. Notes off.");
  });
  $("latch").addEventListener("click", () => {
    state.latch = !state.latch;
    $("latch").setAttribute("aria-pressed", state.latch ? "true" : "false");
    if (!state.latch) {
      state.sounding = handChord();
      state.order = state.sounding.slice();
    }
    paintHarmony();
    scheduleSave();
  });
  $("walk").addEventListener("click", () => {
    state.walk = !state.walk;
    $("walk").setAttribute("aria-pressed", state.walk ? "true" : "false");
    paintHarmony();
    scheduleSave();
  });
  $("capture").addEventListener("click", () => {
    const notes = handChord();
    if (!notes.length) {
      setStatus("Nothing to capture.");
      return;
    }
    state.slots[state.armed] = notes.slice();
    paintHarmony();
    scheduleSave();
    setStatus(`Slot ${state.armed + 1} holds ${formatNotes(notes)}.`);
  });
  $("clear-slot").addEventListener("click", () => {
    state.slots[state.armed] = [];
    paintHarmony();
    scheduleSave();
  });
  $("oct-down").addEventListener("click", () => shiftBase(-12));
  $("oct-up").addEventListener("click", () => shiftBase(12));
  $("reseed").addEventListener("click", () => {
    state.seed = 1 + Math.floor(Math.random() * 999998);
    $("seed").value = String(state.seed);
    scheduleSave();
  });
  $("step-count").addEventListener("change", () => {
    resizeLanes(Number($("step-count").value));
    scheduleSave();
  });

  const numeric = [
    ["bpm", "bpm", 40, 240],
    ["seed", "seed", 1, 999999],
    ["bars", "bars", 1, 16],
    ["midi-channel", "channel", 1, 16],
  ];
  for (const [id, key, min, max] of numeric) {
    $(id).addEventListener("input", () => {
      const value = clamp(Number($(id).value) || min, min, max);
      state[key] = key === "seed" || key === "channel" || key === "bars" || key === "bpm" ? Math.round(value) : value;
      scheduleSave();
    });
  }
  const ranges = ["gate", "swing", "cutoff", "resonance", "attack", "decay", "sustain", "release", "gain"];
  for (const key of ranges) {
    $(key).addEventListener("input", () => {
      state[key] = Number($(key).value);
      paintFaders();
      scheduleSave();
    });
  }
  $("rate").addEventListener("change", () => {
    state.rate = Number($("rate").value);
    scheduleSave();
  });
  $("preset-name").addEventListener("input", () => {
    state.name = $("preset-name").value.slice(0, 48);
    scheduleSave();
  });
  $("preset-select").addEventListener("change", () => {
    const preset = findPreset($("preset-select").value);
    if (preset) applyPreset(preset);
  });
  $("store").addEventListener("click", () => {
    const preset = collectPreset();
    if (!preset.name.trim()) {
      setStatus("Name the preset before storing it.");
      return;
    }
    const index = state.userPresets.findIndex((item) => item.name === preset.name);
    if (index >= 0) state.userPresets[index] = preset;
    else state.userPresets.push(preset);
    saveJson(BANK_KEY, state.userPresets);
    fillPresetSelect();
    $("preset-select").value = preset.name;
    setStatus(`Stored “${preset.name}” in this browser.`);
  });
  $("download-preset").addEventListener("click", () => {
    const preset = collectPreset();
    const bytes = new TextEncoder().encode(writeJsonObject(preset));
    triggerDownload(bytes, `${slug(preset.name)}.json`, "application/json");
  });
  $("load-preset").addEventListener("click", () => $("preset-file").click());
  $("preset-file").addEventListener("change", async () => {
    const file = $("preset-file").files?.[0];
    $("preset-file").value = "";
    if (!file) return;
    try {
      applyPreset(readJsonObject(await file.text()));
      setStatus(`Loaded ${state.name}.`);
    } catch {
      setStatus("That file is not a preset object.");
    }
  });
  $("export-midi").addEventListener("click", () => {
    const chords = chordsForExport();
    if (!chords.some((chord) => chord.notes.length)) {
      setStatus("Capture a chord before exporting.");
      return;
    }
    const { events } = renderArp(chords, arpParams());
    triggerDownload(
      encodeMidi({ events, bpm: state.bpm, name: state.name, channel: state.channel - 1 }),
      `${slug(state.name)}.mid`,
      "audio/midi",
    );
    setStatus(`MIDI loop, ${events.length} notes.`);
  });
  $("export-wav").addEventListener("click", () => {
    const chords = chordsForExport();
    if (!chords.some((chord) => chord.notes.length)) {
      setStatus("Capture a chord before exporting.");
      return;
    }
    setStatus("Rendering the loop…");
    window.setTimeout(() => {
      try {
        const { events } = renderArp(chords, arpParams());
        const audio = renderVoices(events, { ...synthParams(), sampleRate: 44100 });
        downloadWav(audio, 44100, `${slug(state.name)}.wav`);
        setStatus("WAV saved.");
      } catch {
        setStatus("The render failed.");
      }
    }, 30);
  });
  $("bus").addEventListener("click", () => {
    state.bus = !state.bus;
    $("bus").setAttribute("aria-pressed", state.bus ? "true" : "false");
    setStatus(state.bus ? "Notes are also sent on the atelier bus." : "Atelier bus muted.");
  });
  $("midi-in").addEventListener("click", async () => {
    state.midiIn = !state.midiIn;
    $("midi-in").setAttribute("aria-pressed", state.midiIn ? "true" : "false");
    await ensureMidi();
    setStatus(state.midiIn ? "Listening to MIDI inputs." : "MIDI input off.");
  });
  $("midi-out").addEventListener("pointerdown", () => {
    ensureMidi();
  });
  $("midi-out").addEventListener("change", () => {
    state.outputId = $("midi-out").value;
    const port = midiAccess?.outputs?.get(state.outputId) || null;
    player.setOutput(port);
    setStatus(port ? `MIDI out: ${port.name || "port"}.` : "MIDI out is the internal synth only.");
  });
}

function shiftBase(delta) {
  state.base = clamp(state.base + delta, 24, 84);
  buildKeyboard();
  scheduleSave();
}

function bindKeys() {
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !textField(event.target)) {
      event.preventDefault();
      if (!event.repeat) togglePlay();
      return;
    }
    const offset = offsetFromKey(event);
    if (offset == null) return;
    event.preventDefault();
    noteOn(state.base + offset, "key");
  });
  window.addEventListener("keyup", (event) => {
    const key = String(event.key || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(KEY_OFFSETS, key)) return;
    noteOff(state.base + KEY_OFFSETS[key], "key");
  });
  window.addEventListener("pointerup", () => {
    if (!held.pointer.size) return;
    held.pointer.clear();
    if (!state.latch) {
      state.order = state.order.filter((note) => isHeld(note));
      state.sounding = state.order.slice();
    }
    paintHarmony();
  });
  window.addEventListener("blur", () => {
    held.key.clear();
    held.pointer.clear();
    if (!state.latch) {
      state.sounding = [];
      state.order = [];
    }
    paintHarmony();
  });
}

async function ensureMidi() {
  if (midiAccess) return midiAccess;
  if (!supportsMidi()) {
    setStatus("No Web MIDI in this browser. The atelier bus still reaches other open atelier tabs.");
    return null;
  }
  try {
    midiAccess = await openMidi();
  } catch {
    setStatus("MIDI permission was denied.");
    return null;
  }
  listenMidi(midiAccess, {
    onNote({ note }) {
      if (state.midiIn) noteOn(note, "midi");
    },
    onNoteOff({ note }) {
      if (state.midiIn) noteOff(note, "midi");
    },
    onStatus() {
      fillMidiPorts();
    },
  });
  return midiAccess;
}

function fillMidiPorts() {
  const select = $("midi-out");
  const current = state.outputId;
  const outputs = midiAccess ? [...midiAccess.outputs.values()] : [];
  select.replaceChildren();
  const internal = document.createElement("option");
  internal.value = "";
  internal.textContent = outputs.length ? "Internal synth" : "Internal synth (no MIDI ports)";
  select.append(internal);
  for (const port of outputs) {
    const option = document.createElement("option");
    option.value = port.id;
    option.textContent = port.name || "MIDI output";
    select.append(option);
  }
  if (outputs.some((port) => port.id === current)) select.value = current;
  else {
    state.outputId = "";
    select.value = "";
  }
  player.setOutput(midiAccess?.outputs?.get(state.outputId) || null);
}

function drawScope() {
  const canvas = $("scope");
  const context = canvas.getContext("2d");
  const buffer = new Uint8Array(1024);
  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.floor(rect.width * ratio));
    canvas.height = Math.max(2, Math.floor(rect.height * ratio));
  };
  fit();
  window.addEventListener("resize", fit);
  const tick = () => {
    requestAnimationFrame(tick);
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = getComputedStyle(document.body).getPropertyValue("--amber").trim() || "#ffb03a";
    context.lineWidth = Math.max(1, width / 240);
    context.beginPath();
    const analyser = player.analyser();
    if (!analyser || !player.playing) {
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
      context.stroke();
      return;
    }
    analyser.getByteTimeDomainData(buffer);
    const step = buffer.length / width;
    for (let x = 0; x < width; x++) {
      const value = buffer[Math.floor(x * step)] / 255;
      const y = value * height;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  };
  tick();
}

player.onStep((step) => {
  state.currentStep = step;
  state.playBeat = step < 0 ? 0 : stepStartBeat(step, arpParams());
  paintSteps();
  if (player.playing) paintHarmony();
});

bindStatic();
bindKeys();
buildKeyboard();
buildSteps();
syncNumbers();
drawScope();

try {
  const response = await fetch("./presets/factory.json");
  if (!response.ok) throw new Error("missing");
  state.factory = await response.json();
  state.userPresets = loadJson(BANK_KEY, []) || [];
  fillPresetSelect();
  const saved = loadJson(SESSION_KEY, null);
  if (saved?.arp) applyPreset(saved, { remember: false });
  else applyPreset(state.factory[0], { remember: false });
  setStatus("Press Play, or hold keys A–K. Space starts the pattern.");
} catch {
  setStatus("Factory presets did not load. The panel still plays a held chord.");
}
