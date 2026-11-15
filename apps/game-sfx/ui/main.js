import factory from "../presets/factory.json" with { type: "json" };
import {
  CATEGORIES,
  PACKS,
  PARAM_KEYS,
  clamp01,
  clampParams,
  defaultParams,
  mutateLocked,
  normalizeCategory,
  renderSfx,
  suggestedFileName,
  varyAround,
} from "../engine.js";
import { downloadWav, encodeWav, triggerDownload } from "../../../shared/wav-export.js";
import { bindKeys, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { parseBank, serializeBank } from "./bank.js";
import { zipStore } from "./zip-store.js";

const SLOT_KEY = "atelier:game-sfx:slots";
const PRESET_KEY = "atelier:game-sfx:presets";

const LABELS = {
  pitch: "Pitch",
  length: "Length",
  punch: "Punch",
  noise: "Noise",
  sweep: "Sweep",
  style: "Era",
};

const KEY_TO_INDEX = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
  Digit5: 4,
  Digit6: 5,
  Digit7: 6,
  Digit8: 7,
  Digit9: 8,
  Digit0: 9,
  Minus: 10,
};

const CC_TO_PARAM = {
  1: "sweep",
  71: "noise",
  72: "length",
  73: "punch",
  74: "style",
};

const state = {
  active: "jump",
  slots: {},
  anchor: null,
  mutateStep: 0,
  rendered: null,
  playing: false,
  source: null,
  audio: null,
  raf: 0,
  playStarted: 0,
  userItems: [],
  midiBound: false,
};

const els = {
  categories: document.querySelector("#categories"),
  faders: document.querySelector("#faders"),
  scope: document.querySelector("#scope"),
  meta: document.querySelector("#meta"),
  status: document.querySelector("#status"),
  readout: document.querySelector("#readout"),
  play: document.querySelector("#btn-play"),
  generate: document.querySelector("#btn-generate"),
  lock: document.querySelector("#btn-lock"),
  mutate: document.querySelector("#btn-mutate"),
  revert: document.querySelector("#btn-revert"),
  audition: document.querySelector("#audition"),
  presetSelect: document.querySelector("#preset-select"),
  presetName: document.querySelector("#preset-name"),
  apply: document.querySelector("#btn-apply"),
  save: document.querySelector("#btn-save"),
  remove: document.querySelector("#btn-remove"),
  downloadJson: document.querySelector("#btn-download-json"),
  importBtn: document.querySelector("#btn-import"),
  importFile: document.querySelector("#import-file"),
  wav: document.querySelector("#btn-wav"),
  uiPack: document.querySelector("#btn-ui-pack"),
  platPack: document.querySelector("#btn-plat-pack"),
};

function setStatus(text) {
  els.status.textContent = text;
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function factoryFor(category) {
  const item = factory.items.find((entry) => normalizeCategory(entry.category) === category);
  if (!item) return { params: defaultParams(), seed: 1 };
  return { params: clampParams(item.params), seed: item.seed >>> 0 };
}

function initSlots() {
  const stored = readJson(SLOT_KEY);
  for (const category of CATEGORIES) {
    const fromFactory = factoryFor(category.id);
    const saved = stored && stored.slots ? stored.slots[category.id] : null;
    if (saved && saved.params && Number.isInteger(Number(saved.seed))) {
      state.slots[category.id] = {
        params: clampParams(saved.params),
        seed: saved.seed >>> 0,
      };
    } else {
      state.slots[category.id] = fromFactory;
    }
  }
  if (stored && normalizeCategory(stored.active)) state.active = normalizeCategory(stored.active);
  if (stored && stored.anchor && normalizeCategory(stored.anchor.category)) {
    state.anchor = {
      category: normalizeCategory(stored.anchor.category),
      params: clampParams(stored.anchor.params),
      seed: stored.anchor.seed >>> 0,
    };
  }
  const savedPresets = readJson(PRESET_KEY);
  if (savedPresets) {
    try {
      state.userItems = parseBank(savedPresets).items;
    } catch {
      state.userItems = [];
    }
  }
}

function persistSlots() {
  try {
    localStorage.setItem(
      SLOT_KEY,
      JSON.stringify({ active: state.active, anchor: state.anchor, slots: state.slots }),
    );
  } catch {
    /* storage full or blocked */
  }
}

function persistPresets() {
  try {
    localStorage.setItem(PRESET_KEY, serializeBank({ version: 1, name: "Saved sounds", items: state.userItems }));
  } catch {
    /* storage full or blocked */
  }
}

function slot() {
  return state.slots[state.active];
}

function renderCurrent() {
  const current = slot();
  state.rendered = renderSfx(state.active, current.params, current.seed);
  paintChrome();
  drawScope(0);
  persistSlots();
}

function paintChrome() {
  const sound = state.rendered;
  const current = slot();
  const hex = current.seed.toString(16).padStart(8, "0");
  const meta = CATEGORIES.find((c) => c.id === state.active);
  const seconds = sound ? sound.duration.toFixed(2) : "0.00";
  els.readout.textContent = `${meta.label.toUpperCase()} · SEED ${hex}`;
  els.meta.textContent = `${seconds}s · 44.1 kHz`;
  const lockedHere = Boolean(state.anchor && state.anchor.category === state.active);
  els.lock.setAttribute("aria-pressed", lockedHere ? "true" : "false");
  els.lock.textContent = lockedHere ? "Locked" : "Lock";
  els.mutate.disabled = !lockedHere;
  els.revert.disabled = !lockedHere;
  for (const key of PARAM_KEYS) {
    const input = document.querySelector(`#param-${key}`);
    const output = document.querySelector(`#out-${key}`);
    if (!input || !output) continue;
    const value = current.params[key];
    if (document.activeElement !== input) input.value = String(value);
    output.textContent = String(Math.round(value * 100)).padStart(2, "0");
  }
  for (const button of els.categories.querySelectorAll(".cat-btn")) {
    button.setAttribute("aria-pressed", button.dataset.category === state.active ? "true" : "false");
  }
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function drawScope(playhead) {
  const canvas = els.scope;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pxW = Math.floor(width * dpr);
  const pxH = Math.floor(height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#07110c";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#1c2a12";
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const samples = state.rendered ? state.rendered.samples : null;
  if (!samples || samples.length === 0) return;
  ctx.beginPath();
  ctx.strokeStyle = cssVar("--phosphor", "#b7d17a");
  ctx.lineWidth = 1.5;
  const step = Math.max(1, Math.floor(samples.length / width));
  for (let x = 0; x < width; x += 1) {
    const i = Math.min(samples.length - 1, x * step);
    let min = 1;
    let max = -1;
    const end = Math.min(samples.length, i + step);
    for (let j = i; j < end; j += 1) {
      const s = samples[j];
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const y1 = (1 - max) * 0.5 * height;
    const y2 = (1 - min) * 0.5 * height;
    ctx.moveTo(x + 0.5, y1);
    ctx.lineTo(x + 0.5, Math.max(y2, y1 + 1));
  }
  ctx.stroke();

  if (playhead > 0 && playhead < 1) {
    const x = playhead * width;
    ctx.strokeStyle = cssVar("--amber", "#ffb03a");
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function audioContext() {
  if (!state.audio) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    state.audio = new Ctor();
  }
  return state.audio;
}

function stopPlayback() {
  if (state.source) {
    try {
      state.source.stop();
    } catch {
      /* already stopped */
    }
    state.source = null;
  }
  state.playing = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
}

function playSamples(samples, sampleRate, gain = 0.9) {
  const ctx = audioContext();
  if (!ctx) {
    setStatus("This browser has no Web Audio.");
    return;
  }
  stopPlayback();
  const resume = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
  resume.then(() => {
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    source.connect(amp).connect(ctx.destination);
    state.source = source;
    state.playing = true;
    state.playStarted = ctx.currentTime;
    const duration = samples.length / sampleRate;
    source.onended = () => {
      if (state.source === source) {
        state.playing = false;
        state.source = null;
        drawScope(0);
      }
    };
    source.start();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = () => {
      if (!state.playing) return;
      const u = (ctx.currentTime - state.playStarted) / duration;
      drawScope(Math.min(1, Math.max(0, u)));
      if (u < 1) state.raf = requestAnimationFrame(frame);
    };
    if (!motion) frame();
  });
}

function playCurrent(gain = 0.9) {
  if (!state.rendered) renderCurrent();
  playSamples(state.rendered.samples, state.rendered.sampleRate, gain);
}

function selectCategory(id, { announce } = {}) {
  const next = normalizeCategory(id);
  if (!next) return;
  state.active = next;
  renderCurrent();
  const meta = CATEGORIES.find((c) => c.id === next);
  if (announce) setStatus(`${meta.label}. ${meta.blurb}.`);
}

function fresh(category) {
  const id = normalizeCategory(category) || state.active;
  state.active = id;
  const anchor = factoryFor(id);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  state.slots[id] = { params: varyAround(anchor.params, seed, 0.2), seed };
  state.anchor = null;
  state.mutateStep = 0;
  renderCurrent();
  setStatus(`New ${CATEGORIES.find((c) => c.id === id).label.toLowerCase()} variation.`);
}

function lockCurrent() {
  if (state.anchor && state.anchor.category === state.active) {
    state.anchor = null;
    state.mutateStep = 0;
    renderCurrent();
    setStatus("Unlocked.");
    return;
  }
  const current = slot();
  state.anchor = {
    category: state.active,
    params: { ...current.params },
    seed: current.seed,
  };
  state.mutateStep = 0;
  renderCurrent();
  setStatus("Locked. Mutate walks a small step away. Revert comes back.");
}

function mutate() {
  if (!state.anchor || state.anchor.category !== state.active) return;
  state.mutateStep += 1;
  const next = mutateLocked(
    { category: state.active, params: slot().params, seed: slot().seed },
    state.mutateStep,
  );
  state.slots[state.active] = { params: next.params, seed: next.seed };
  renderCurrent();
  setStatus(`Mutated, step ${state.mutateStep}.`);
}

function revert() {
  if (!state.anchor || state.anchor.category !== state.active) return;
  state.slots[state.active] = {
    params: { ...state.anchor.params },
    seed: state.anchor.seed,
  };
  state.mutateStep = 0;
  renderCurrent();
  setStatus("Reverted to the locked sound.");
}

function buildCategories() {
  CATEGORIES.forEach((category, index) => {
    const row = document.createElement("div");
    row.className = "cat-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key cat-btn";
    button.dataset.category = category.id;
    button.setAttribute("aria-pressed", "false");
    const title = document.createElement("span");
    title.textContent = `${String(index + 1).padStart(2, "0")}  ${category.label}`;
    const blurb = document.createElement("small");
    blurb.textContent = category.blurb;
    button.append(title, blurb);
    button.addEventListener("click", () => selectCategory(category.id, { announce: true }));
    const neu = document.createElement("button");
    neu.type = "button";
    neu.className = "key";
    neu.textContent = "New";
    neu.setAttribute("aria-label", `New ${category.label} variation`);
    neu.addEventListener("click", () => {
      fresh(category.id);
      playCurrent();
    });
    row.append(button, neu);
    els.categories.append(row);
  });
}

function buildFaders() {
  for (const key of PARAM_KEYS) {
    const wrap = document.createElement("label");
    wrap.className = "slider";
    const top = document.createElement("div");
    top.className = "slider-top";
    const name = document.createElement("span");
    name.className = "slider-name";
    name.textContent = LABELS[key];
    const output = document.createElement("span");
    output.className = "slider-value";
    output.id = `out-${key}`;
    output.textContent = "00";
    top.append(name, output);
    const input = document.createElement("input");
    input.type = "range";
    input.id = `param-${key}`;
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = String(slot().params[key]);
    input.setAttribute("aria-label", LABELS[key]);
    input.addEventListener("input", () => {
      slot().params[key] = clamp01(input.value);
      output.textContent = String(Math.round(slot().params[key] * 100)).padStart(2, "0");
      renderCurrent();
    });
    input.addEventListener("change", () => {
      if (els.audition.checked) playCurrent();
    });
    wrap.append(top, input);
    if (key === "style") {
      const ends = document.createElement("div");
      ends.className = "scale";
      const retro = document.createElement("span");
      retro.textContent = "Retro";
      const modern = document.createElement("span");
      modern.textContent = "Modern";
      ends.append(retro, modern);
      wrap.append(ends);
    }
    els.faders.append(wrap);
  }
}

function presetOptions() {
  const select = els.presetSelect;
  select.replaceChildren();
  const factoryGroup = document.createElement("optgroup");
  factoryGroup.label = "Factory";
  factory.items.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = `f-${index}`;
    option.textContent = item.name;
    factoryGroup.append(option);
  });
  select.append(factoryGroup);
  const saved = document.createElement("optgroup");
  saved.label = "Saved";
  if (state.userItems.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "None yet";
    option.disabled = true;
    saved.append(option);
  } else {
    state.userItems.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = `u-${index}`;
      option.textContent = item.name;
      saved.append(option);
    });
  }
  select.append(saved);
}

function selectedPreset() {
  const match = /^(f|u)-(\d+)$/.exec(els.presetSelect.value);
  if (!match) return null;
  const list = match[1] === "f" ? factory.items : state.userItems;
  return list[Number(match[2])] || null;
}

function applyPreset() {
  const item = selectedPreset();
  if (!item) {
    setStatus("Pick a preset first.");
    return;
  }
  const category = normalizeCategory(item.category);
  if (!category) {
    setStatus("That preset uses an unknown voice.");
    return;
  }
  state.active = category;
  state.slots[category] = { params: clampParams(item.params), seed: item.seed >>> 0 };
  state.anchor = null;
  state.mutateStep = 0;
  els.presetName.value = item.name;
  renderCurrent();
  setStatus(`Applied ${item.name}.`);
  playCurrent();
}

function savePreset() {
  const name = els.presetName.value.trim();
  if (!name) {
    setStatus("Name the sound before saving.");
    els.presetName.focus();
    return;
  }
  const current = slot();
  const items = state.userItems.filter(
    (item) => !(item.name === name && normalizeCategory(item.category) === state.active),
  );
  items.push({
    name,
    category: state.active,
    seed: current.seed,
    params: { ...current.params },
  });
  state.userItems = items;
  persistPresets();
  presetOptions();
  els.presetSelect.value = `u-${state.userItems.length - 1}`;
  setStatus(`Saved ${name} in this browser.`);
}

function removePreset() {
  const value = els.presetSelect.value;
  if (!value.startsWith("u-")) {
    setStatus("Select a saved preset to remove. Factory sounds stay.");
    return;
  }
  const index = Number(value.slice(2));
  state.userItems = state.userItems.filter((_, i) => i !== index);
  persistPresets();
  presetOptions();
  setStatus("Removed the saved preset.");
}

function downloadJson() {
  const items = CATEGORIES.map((category) => {
    const current = state.slots[category.id];
    return {
      name: category.label,
      category: category.id,
      seed: current.seed,
      params: current.params,
    };
  });
  const text = serializeBank({ version: 1, name: "Game sound bench", items });
  triggerDownload(new TextEncoder().encode(text), "game-sfx-bench.json", "application/json");
  setStatus("Downloaded the bench as JSON.");
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const bank = parseBank(String(reader.result));
      const accepted = bank.items.filter((item) => normalizeCategory(item.category));
      if (accepted.length === 0) throw new Error("No usable presets in that file.");
      state.userItems = [...state.userItems, ...accepted];
      persistPresets();
      presetOptions();
      const first = accepted[0];
      state.active = normalizeCategory(first.category);
      state.slots[state.active] = { params: clampParams(first.params), seed: first.seed };
      state.anchor = null;
      state.mutateStep = 0;
      renderCurrent();
      setStatus(`Imported ${accepted.length} preset${accepted.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read that JSON.");
    }
  };
  reader.readAsText(file);
}

function exportCurrent() {
  const sound = state.rendered || renderSfx(state.active, slot().params, slot().seed);
  downloadWav(sound.samples, sound.sampleRate, sound.suggestedName);
  setStatus(`Downloaded ${sound.suggestedName}.`);
}

function exportPack(pack) {
  const entries = pack.categories.map((category) => {
    const current = state.slots[category];
    const sound = renderSfx(category, current.params, current.seed);
    return {
      name: suggestedFileName(category, current.seed, pack.id),
      data: encodeWav(sound.samples, sound.sampleRate),
    };
  });
  triggerDownload(zipStore(entries), pack.filename, "application/zip");
  setStatus(`Downloaded ${pack.filename} · ${entries.length} files.`);
}

function pickIndex(index) {
  const category = CATEGORIES[index];
  if (!category) return;
  selectCategory(category.id, { announce: true });
  playCurrent();
}

function onMidiNote(note, velocity) {
  const semis = note - 60;
  const params = {
    ...slot().params,
    pitch: clamp01(slot().params.pitch + semis / 24),
  };
  const sound = renderSfx(state.active, params, slot().seed);
  playSamples(sound.samples, sound.sampleRate, 0.35 + velocity * 0.65);
  setStatus(`MIDI note ${note}.`);
}

function bind() {
  els.play.addEventListener("click", () => playCurrent());
  els.generate.addEventListener("click", () => {
    fresh(state.active);
    playCurrent();
  });
  els.lock.addEventListener("click", lockCurrent);
  els.mutate.addEventListener("click", () => {
    mutate();
    playCurrent();
  });
  els.revert.addEventListener("click", revert);
  els.apply.addEventListener("click", applyPreset);
  els.save.addEventListener("click", savePreset);
  els.remove.addEventListener("click", removePreset);
  els.downloadJson.addEventListener("click", downloadJson);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", () => {
    const file = els.importFile.files && els.importFile.files[0];
    if (file) importJson(file);
    els.importFile.value = "";
  });
  els.wav.addEventListener("click", exportCurrent);
  els.uiPack.addEventListener("click", () => exportPack(PACKS.ui));
  els.platPack.addEventListener("click", () => exportPack(PACKS.platformer));

  const keys = {
    Space: () => playCurrent(),
    KeyG: () => {
      fresh(state.active);
      playCurrent();
    },
    KeyL: () => lockCurrent(),
    KeyM: () => {
      mutate();
      if (state.anchor) playCurrent();
    },
  };
  for (const [code, index] of Object.entries(KEY_TO_INDEX)) {
    keys[code] = () => pickIndex(index);
  }
  bindKeys(keys, window);
  window.addEventListener("resize", () => drawScope(0));

  const armMidi = () => {
    if (state.midiBound) return;
    state.midiBound = true;
    bindMidiPerformance({
      onNote: ({ note, velocity }) => onMidiNote(note, velocity),
      onCC: ({ controller, value }) => {
        const key = CC_TO_PARAM[controller];
        if (!key) return;
        slot().params[key] = clamp01(value);
        renderCurrent();
      },
      onStatus: (status) => {
        if (status && status.inputs && status.inputs.length) setStatus(`MIDI · ${status.message}`);
      },
    });
  };
  window.addEventListener("pointerdown", armMidi, { once: true });
}

initSlots();
buildCategories();
buildFaders();
presetOptions();
bind();
renderCurrent();
setStatus("Pick a voice, or press Generate for a fresh take.");
drawScope(0);
