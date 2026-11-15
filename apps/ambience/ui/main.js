/* Atelier Instruments — MIT License. Panel for the ambient texture generator. */
import { KIND_LABELS, KINDS, renderAmbience } from "../engine.js";
import { bindKeys, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { presetFilename } from "../../../shared/presets.js";
import { downloadWavChannels, triggerDownload } from "../../../shared/wav-export.js";

const PATCH_KEY = "atelier-ambience-patch";
const USER_KEY = "atelier-ambience-user-presets";
const FACTORY_FILES = [
  "still-water.json",
  "night-rain.json",
  "hollow-stone.json",
  "canopy.json",
  "after-hours.json",
  "drift.json",
  "held-breath.json",
  "glass-storm.json",
];
const SLIDERS = [
  ["level", "Level", "Loudness of this layer"],
  ["tone", "Tone", "Brightness and pitch center"],
  ["movement", "Move", "How fast the texture evolves"],
  ["density", "Dens", "Thickness, drops, partials"],
];

const state = {
  mood: 0.18,
  seed: 2048,
  length: 16,
  preset: "Still Water",
  selected: 0,
  layers: [],
};

let factory = [];
let wantPlay = false;
let rendering = false;
let dirty = false;
let audioCtx = null;
let master = null;
let analyser = null;
let playing = null;
let worker = null;
let jobSeq = 0;
let commitTimer = 0;
let midiStop = null;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const cards = [];

const els = {
  layers: document.getElementById("layers"),
  mood: document.getElementById("mood"),
  moodRead: document.getElementById("mood-read"),
  seed: document.getElementById("seed"),
  seedRead: document.getElementById("seed-readout"),
  length: document.getElementById("length"),
  preset: document.getElementById("preset"),
  status: document.getElementById("status"),
  midi: document.getElementById("midi-status"),
  play: document.getElementById("play"),
  stop: document.getElementById("stop"),
  exportBtn: document.getElementById("export"),
  shuffle: document.getElementById("shuffle"),
  save: document.getElementById("save"),
  load: document.getElementById("load"),
  file: document.getElementById("preset-file"),
  midiBtn: document.getElementById("midi"),
  field: document.getElementById("field"),
};

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function blankLayer(kind = "drone") {
  return { kind, level: 0, tone: 0.45, movement: 0.3, density: 0.4 };
}

function padLayers(layers) {
  const next = [];
  for (const layer of layers || []) {
    if (next.length >= 6 || !layer || typeof layer !== "object") continue;
    const kind = KINDS.includes(layer.kind) ? layer.kind : "drone";
    next.push({
      kind,
      level: clamp01(layer.level),
      tone: clamp01(layer.tone ?? 0.5),
      movement: clamp01(layer.movement ?? 0.4),
      density: clamp01(layer.density ?? 0.5),
    });
  }
  while (next.length < 6) next.push(blankLayer());
  return next;
}

function spec() {
  return { mood: state.mood, layers: state.layers.map((layer) => ({ ...layer })) };
}

function moodWord(mood) {
  if (mood < 0.34) return "Calm " + mood.toFixed(2);
  if (mood < 0.67) return "Uneasy " + mood.toFixed(2);
  return "Tense " + mood.toFixed(2);
}

function setStatus(text) {
  els.status.textContent = text;
}

function remember() {
  try {
    localStorage.setItem(PATCH_KEY, JSON.stringify({
      name: state.preset,
      mood: state.mood,
      seed: state.seed,
      length: state.length,
      layers: state.layers,
    }));
  } catch {
    /* storage may be blocked */
  }
}

function readStored() {
  try {
    const data = JSON.parse(localStorage.getItem(PATCH_KEY) || "null");
    if (!data || typeof data !== "object" || !Array.isArray(data.layers)) return null;
    return data;
  } catch {
    return null;
  }
}

function readUserPresets() {
  try {
    const data = JSON.parse(localStorage.getItem(USER_KEY) || "[]");
    return Array.isArray(data) ? data.filter((item) => item && item.name && Array.isArray(item.layers)) : [];
  } catch {
    return [];
  }
}

function writeUserPresets(presets) {
  localStorage.setItem(USER_KEY, JSON.stringify(presets));
}

function option(value, text) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = text;
  return node;
}

function refreshPresets() {
  const current = state.preset;
  els.preset.replaceChildren(option("Custom", "Custom"));
  for (const preset of factory) els.preset.append(option(preset.name, preset.name));
  for (const preset of readUserPresets()) els.preset.append(option(preset.name, preset.name + " · kept"));
  if ([...els.preset.options].some((item) => item.value === current)) els.preset.value = current;
}

function buildLayers() {
  els.layers.replaceChildren();
  cards.length = 0;
  state.layers.forEach((layer, index) => {
    const card = document.createElement("article");
    card.className = "layer" + (index === state.selected ? " is-selected" : "");
    const head = document.createElement("div");
    head.className = "layer-head";
    const title = document.createElement("span");
    title.className = "slider-name";
    title.textContent = "Layer " + String(index + 1).padStart(2, "0");
    const lamp = document.createElement("span");
    lamp.className = layer.level > 0 ? "lamp on" : "lamp";
    lamp.setAttribute("aria-hidden", "true");
    head.append(title, lamp);

    const kind = document.createElement("select");
    kind.className = "layer-kind";
    kind.setAttribute("aria-label", "Layer " + (index + 1) + " kind");
    for (const name of KINDS) kind.append(option(name, KIND_LABELS[name]));
    kind.value = layer.kind;

    card.append(head, kind);
    const controls = {};
    for (const [key, label, hint] of SLIDERS) {
      const row = document.createElement("label");
      row.className = "slider slider-row";
      const name = document.createElement("span");
      name.className = "slider-name";
      name.textContent = label;
      name.title = hint;
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";
      input.value = String(layer[key]);
      input.setAttribute("aria-label", "Layer " + (index + 1) + " " + label);
      input.title = hint;
      const read = document.createElement("span");
      read.className = "peak";
      read.textContent = Number(layer[key]).toFixed(2);
      input.addEventListener("input", () => {
        state.layers[index][key] = clamp01(input.value);
        read.textContent = state.layers[index][key].toFixed(2);
        lamp.className = state.layers[index].level > 0 ? "lamp on" : "lamp";
        markCustom();
        selectLayer(index, false);
      });
      input.addEventListener("change", commit);
      row.append(name, input, read);
      card.append(row);
      controls[key] = { input, read };
    }
    kind.addEventListener("change", () => {
      state.layers[index].kind = kind.value;
      markCustom();
      selectLayer(index, false);
      commit();
    });
    card.addEventListener("pointerdown", () => selectLayer(index, false));
    els.layers.append(card);
    cards.push({ card, kind, controls, lamp });
  });
}

function selectLayer(index, focus) {
  if (!cards[index]) return;
  state.selected = index;
  cards.forEach((card, i) => card.card.classList.toggle("is-selected", i === index));
  if (focus) cards[index].kind.focus();
}

function paint() {
  els.mood.value = String(state.mood);
  els.moodRead.textContent = moodWord(state.mood);
  els.seed.value = String(state.seed);
  els.seedRead.textContent = "SEED " + state.seed;
  els.length.value = String(state.length);
  if ([...els.preset.options].some((item) => item.value === state.preset)) els.preset.value = state.preset;
  cards.forEach((card, index) => {
    const layer = state.layers[index];
    card.kind.value = layer.kind;
    card.lamp.className = layer.level > 0 ? "lamp on" : "lamp";
    for (const [key, ui] of Object.entries(card.controls)) {
      ui.input.value = String(layer[key]);
      ui.read.textContent = Number(layer[key]).toFixed(2);
    }
  });
}

function markCustom() {
  if (state.preset === "Custom") return;
  state.preset = "Custom";
  els.preset.value = "Custom";
}

function applyPreset(preset, label) {
  state.mood = clamp01(preset.mood ?? 0.3);
  const seed = Math.round(Number(preset.seed));
  if (Number.isFinite(seed)) state.seed = Math.max(0, seed);
  const length = Number(preset.length);
  if ([8, 12, 16, 24, 36, 60].includes(length)) state.length = length;
  state.layers = padLayers(preset.layers);
  state.preset = label || preset.name || "Custom";
  buildLayers();
  paint();
  remember();
  if (wantPlay) scheduleRender();
}

function commit() {
  remember();
  paint();
  if (!wantPlay) return;
  window.clearTimeout(commitTimer);
  commitTimer = window.setTimeout(() => scheduleRender(), 160);
}

function scheduleRender() {
  dirty = true;
  void pump();
}

async function pump() {
  if (!wantPlay || rendering) return;
  rendering = true;
  els.play.disabled = true;
  try {
    do {
      dirty = false;
      const seconds = state.length;
      setStatus("Rendering " + seconds + "s");
      const audio = await renderSpec(spec(), seconds, state.seed);
      if (!wantPlay) break;
      await playBuffer(audio);
      if (!dirty) {
        setStatus("Looping " + seconds + "s");
        els.play.textContent = "Playing";
        els.play.classList.add("is-live");
      }
    } while (dirty && wantPlay);
  } catch (error) {
    wantPlay = false;
    setStatus(error instanceof Error ? error.message : "Render failed");
  } finally {
    rendering = false;
    els.play.disabled = false;
    if (!wantPlay) {
      els.play.textContent = "Play";
      els.play.classList.remove("is-live");
    }
  }
}

function getWorker() {
  if (!worker) worker = new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  return worker;
}

function directRender(body, seconds, seed) {
  const audio = renderAmbience(body, seconds, seed);
  return { sampleRate: audio.sampleRate, seed: audio.seed, left: audio.left, right: audio.right };
}

function renderSpec(body, seconds, seed) {
  return new Promise((resolve, reject) => {
    let host;
    try {
      host = getWorker();
    } catch {
      resolve(directRender(body, seconds, seed));
      return;
    }
    const id = ++jobSeq;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      host.removeEventListener("message", onMessage);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Render timed out")), 30000);
    const onMessage = (event) => {
      if (!event.data || event.data.id !== id) return;
      if (!event.data.ok) finish(reject, new Error(event.data.error || "Render failed"));
      else finish(resolve, event.data);
    };
    host.addEventListener("message", onMessage);
    host.addEventListener("error", () => finish(resolve, directRender(body, seconds, seed)), { once: true });
    host.postMessage({ id, layers: body, seconds, seed });
  });
}

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    master = audioCtx.createGain();
    master.gain.value = 0.9;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    master.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  return audioCtx;
}

async function playBuffer(audio) {
  const ctx = ensureAudio();
  await ctx.resume();
  const buffer = ctx.createBuffer(2, audio.left.length, audio.sampleRate);
  buffer.getChannelData(0).set(audio.left);
  buffer.getChannelData(1).set(audio.right);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  source.connect(gain);
  gain.connect(master);
  source.start();
  gain.gain.linearRampToValueAtTime(1, now + 0.4);
  const previous = playing;
  playing = { source, gain };
  if (previous) {
    previous.gain.gain.cancelScheduledValues(now);
    previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
    previous.gain.gain.linearRampToValueAtTime(0, now + 0.4);
    window.setTimeout(() => {
      try { previous.source.stop(); } catch { /* already stopped */ }
      try { previous.source.disconnect(); previous.gain.disconnect(); } catch { /* already gone */ }
    }, 480);
  }
}

function stopPlayback() {
  wantPlay = false;
  dirty = false;
  if (playing && audioCtx) {
    const now = audioCtx.currentTime;
    playing.gain.gain.cancelScheduledValues(now);
    playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
    playing.gain.gain.linearRampToValueAtTime(0, now + 0.18);
    const previous = playing;
    playing = null;
    window.setTimeout(() => {
      try { previous.source.stop(); } catch { /* already stopped */ }
    }, 240);
  }
  els.play.textContent = "Play";
  els.play.classList.remove("is-live");
  setStatus("Stopped");
}

async function onPlay() {
  wantPlay = true;
  ensureAudio();
  await audioCtx.resume();
  els.play.textContent = "Rendering";
  scheduleRender();
}

async function onExport() {
  els.exportBtn.disabled = true;
  setStatus("Writing " + state.length + "s WAV");
  try {
    const audio = await renderSpec(spec(), state.length, state.seed);
    const slug = presetFilename(state.preset || "ambience").replace(/\.json$/, "");
    downloadWavChannels([audio.left, audio.right], audio.sampleRate, slug + "-" + audio.seed + ".wav");
    setStatus(wantPlay ? "Looping " + state.length + "s" : "Saved " + state.length + "s loop");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Export failed");
  } finally {
    els.exportBtn.disabled = false;
  }
}

function onSave() {
  const suggested = state.preset === "Custom" ? "Untitled bed" : state.preset;
  const name = window.prompt("Preset name", suggested);
  if (!name) return;
  const preset = {
    name: name.trim() || suggested,
    mood: state.mood,
    seed: state.seed,
    layers: state.layers,
  };
  const stored = readUserPresets().filter((item) => item.name !== preset.name);
  stored.push(preset);
  writeUserPresets(stored);
  const bytes = new TextEncoder().encode(JSON.stringify(preset, null, 2) + "\n");
  triggerDownload(bytes, presetFilename(preset.name), "application/json");
  state.preset = preset.name;
  refreshPresets();
  remember();
}

async function onLoad(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || !Array.isArray(data.layers)) throw new Error("bad");
    applyPreset(data, data.name || file.name.replace(/\.json$/i, ""));
    refreshPresets();
  } catch {
    setStatus("That file is not a preset");
  }
}

function shuffle() {
  const bag = [...KINDS];
  const layers = KINDS.map((kind) => blankLayer(kind));
  for (let i = 0; i < 3; i += 1) {
    const pick = bag.splice(Math.floor(Math.random() * bag.length), 1)[0];
    const slot = layers.findIndex((layer) => layer.kind === pick);
    layers[slot] = {
      kind: pick,
      level: 0.55 + Math.random() * 0.4,
      tone: Math.random(),
      movement: Math.random() * 0.7,
      density: 0.25 + Math.random() * 0.6,
    };
  }
  state.layers = layers;
  state.mood = Math.random();
  state.seed = Math.floor(Math.random() * 900000) + 1;
  state.preset = "Custom";
  buildLayers();
  paint();
  remember();
  if (wantPlay) scheduleRender();
}

els.mood.addEventListener("input", () => {
  state.mood = clamp01(els.mood.value);
  els.moodRead.textContent = moodWord(state.mood);
  markCustom();
});
els.mood.addEventListener("change", commit);
els.seed.addEventListener("change", () => {
  const n = Math.round(Number(els.seed.value));
  state.seed = Number.isFinite(n) ? Math.max(0, n) : 1;
  markCustom();
  commit();
});
els.length.addEventListener("change", () => {
  state.length = Number(els.length.value);
  commit();
});
els.preset.addEventListener("change", () => {
  const name = els.preset.value;
  if (name === "Custom") return;
  const found = factory.find((preset) => preset.name === name)
    || readUserPresets().find((preset) => preset.name === name);
  if (found) applyPreset(found, found.name);
});
els.play.addEventListener("click", () => { void onPlay(); });
els.stop.addEventListener("click", stopPlayback);
els.exportBtn.addEventListener("click", () => { void onExport(); });
els.shuffle.addEventListener("click", shuffle);
els.save.addEventListener("click", onSave);
els.load.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", (event) => { void onLoad(event); });
els.midiBtn.addEventListener("click", () => { void armMidi(); });

bindKeys({
  Space() {
    if (wantPlay) stopPlayback();
    else void onPlay();
  },
  Digit1() { selectLayer(0, true); },
  Digit2() { selectLayer(1, true); },
  Digit3() { selectLayer(2, true); },
  Digit4() { selectLayer(3, true); },
  Digit5() { selectLayer(4, true); },
  Digit6() { selectLayer(5, true); },
  BracketLeft() { nudgeMood(-0.02); },
  BracketRight() { nudgeMood(0.02); },
});

function nudgeMood(delta) {
  state.mood = clamp01(state.mood + delta);
  markCustom();
  paint();
  commit();
}

async function armMidi() {
  if (midiStop) {
    midiStop();
    midiStop = null;
    els.midi.textContent = "MIDI off";
    els.midiBtn.textContent = "Enable MIDI";
    return;
  }
  midiStop = await bindMidiPerformance({
    onStatus(info) {
      els.midi.textContent = info.message || (info.available ? "MIDI on" : "MIDI off");
    },
    onCC({ controller, value }) {
      const layer = state.layers[state.selected];
      if (!layer) return;
      if (controller === 1) state.mood = value;
      else if (controller === 7) layer.level = value;
      else if (controller === 74) layer.tone = value;
      else if (controller === 71) layer.movement = value;
      else if (controller === 12) layer.density = value;
      else return;
      markCustom();
      paint();
      commit();
    },
  });
  els.midiBtn.textContent = "MIDI on";
}

const wave = new Uint8Array(1024);
const ctx2d = els.field.getContext("2d");

function strokeFor(kind) {
  if (kind === "dread") return "#e23b32";
  if (kind === "forest" || kind === "ocean" || kind === "cave") return "#b7d17a";
  return "#ffb03a";
}

function draw(now) {
  const canvas = els.field;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(280, Math.floor(rect.width * dpr));
  const height = Math.max(120, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx2d.clearRect(0, 0, width, height);
  ctx2d.strokeStyle = "#2c261f";
  ctx2d.lineWidth = 1;
  for (let y = 36; y < height; y += 36) {
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(width, y);
    ctx2d.stroke();
  }
  let energy = 0.35;
  if (analyser && wantPlay) {
    analyser.getByteTimeDomainData(wave);
    let acc = 0;
    for (let i = 0; i < wave.length; i += 8) {
      const v = (wave[i] - 128) / 128;
      acc += v * v;
    }
    energy = Math.min(1, Math.sqrt(acc / (wave.length / 8)) * 4);
    ctx2d.beginPath();
    ctx2d.strokeStyle = "rgba(234, 220, 196, 0.35)";
    for (let x = 0; x < width; x += 3) {
      const sample = wave[x % wave.length] / 255;
      const y = height * 0.5 + (sample - 0.5) * height * 0.8;
      if (x === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
  const t = reducedMotion ? 0 : now / 1000;
  state.layers.forEach((layer, index) => {
    if (layer.level <= 0.001) return;
    const band = 24 + index * ((height - 40) / 6);
    const amp = (8 + layer.level * 24) * (0.65 + energy);
    ctx2d.beginPath();
    ctx2d.strokeStyle = strokeFor(layer.kind);
    ctx2d.globalAlpha = 0.4 + layer.level * 0.6;
    ctx2d.lineWidth = index === state.selected ? 2 : 1.2;
    const freq = 0.008 + layer.tone * 0.02 + index * 0.003;
    const travel = t * (0.4 + layer.movement * 2.2);
    for (let x = 0; x <= width; x += 6) {
      const y = band + Math.sin(x * freq + travel + state.seed * 0.01) * amp * (0.45 + layer.density * 0.7);
      if (x === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  });
  window.requestAnimationFrame(draw);
}

async function boot() {
  try {
    factory = [];
    for (const file of FACTORY_FILES) {
      const response = await fetch(new URL("../presets/" + file, import.meta.url));
      if (!response.ok) throw new Error(file);
      factory.push(await response.json());
    }
  } catch {
    factory = [];
    setStatus("Presets failed to load");
  }
  refreshPresets();
  const stored = readStored();
  if (stored) applyPreset(stored, stored.name || "Custom");
  else if (factory[0]) applyPreset(factory[0], factory[0].name);
  else {
    state.layers = padLayers([blankLayer("ocean"), blankLayer("drone")]);
    state.layers[0].level = 0.8;
    buildLayers();
    paint();
  }
  window.requestAnimationFrame(draw);
}

void boot();
