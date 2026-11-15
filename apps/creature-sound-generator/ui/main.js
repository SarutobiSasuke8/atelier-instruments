// Atelier Instruments — MIT License
import {
  GESTURES,
  MOODS,
  SPECIES,
  blendLabel,
  renderCreature,
  sizeLabel,
} from "../engine.js";
import { downloadWav, encodeWav, triggerDownload } from "../../../shared/wav-export.js";
import {
  downloadJson,
  loadStoredPresets,
  parsePreset,
  storePresets,
} from "../../../shared/presets.js";
import { bindKeys, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { zipStore } from "./zip-store.js";

const STORE_KEY = "atelier:creature-sound-generator:presets";
const PANEL_KEY = "atelier:creature-sound-generator:panel";

const els = {
  size: document.querySelector("#size"),
  mood: document.querySelector("#mood"),
  species: document.querySelector("#species"),
  roughness: document.querySelector("#roughness"),
  volume: document.querySelector("#volume"),
  sizeValue: document.querySelector("#sizeValue"),
  moodValue: document.querySelector("#moodValue"),
  speciesValue: document.querySelector("#speciesValue"),
  roughValue: document.querySelector("#roughValue"),
  levelValue: document.querySelector("#levelValue"),
  readout: document.querySelector("#readout"),
  speciesCaption: document.querySelector("#speciesCaption"),
  gestureCaption: document.querySelector("#gestureCaption"),
  scope: document.querySelector("#scope"),
  meter: document.querySelector("#meter"),
  preset: document.querySelector("#preset"),
  presetName: document.querySelector("#presetName"),
  midi: document.querySelector("#midi"),
  exportBatch: document.querySelector("#exportBatch"),
  pads: [...document.querySelectorAll(".pad")],
};

const state = {
  gesture: "idle",
  seed: null,
  samples: null,
  sampleRate: 44100,
  duration: 0,
  speciesName: "beast",
  moodName: "happy",
  ctx: null,
  source: null,
  analyser: null,
  gain: null,
  startedAt: 0,
  playing: false,
  mouth: 0,
  factory: [],
  batching: false,
};

for (let i = 0; i < 12; i++) {
  const lamp = document.createElement("i");
  els.meter.append(lamp);
}

function params(velocity = 1) {
  return {
    size: Number(els.size.value),
    mood: Number(els.mood.value),
    species: Number(els.species.value),
    roughness: Number(els.roughness.value),
    gesture: state.gesture,
    velocity,
  };
}

function freshSeed() {
  const a = Math.floor(Math.random() * 0x100000000);
  const b = (Date.now() & 0xffff) << 8;
  return (a ^ b) >>> 0;
}

function hexSeed(seed) {
  if (seed == null) return "------";
  return seed.toString(16).toUpperCase().padStart(6, "0");
}

function slug(text) {
  return String(text || "creature")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "creature";
}

function updateLabels() {
  const mood = Number(els.mood.value);
  const species = Number(els.species.value);
  els.sizeValue.textContent = sizeLabel(Number(els.size.value));
  els.moodValue.textContent = blendLabel(mood, MOODS);
  els.speciesValue.textContent = blendLabel(species, SPECIES);
  els.roughValue.textContent = `${Math.round(Number(els.roughness.value) * 100)}%`;
  els.levelValue.textContent = `${Math.round(Number(els.volume.value) * 100)}%`;
  els.speciesCaption.textContent = blendLabel(species, SPECIES);
  els.gestureCaption.textContent = state.gesture.toUpperCase();
  if (state.gain) state.gain.gain.value = Number(els.volume.value);
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({
      size: els.size.value,
      mood: els.mood.value,
      species: els.species.value,
      roughness: els.roughness.value,
      volume: els.volume.value,
    }));
  } catch { /* private mode */ }
}

function setReadout(text) {
  els.readout.textContent = text;
}

function markHot(gesture) {
  for (const pad of els.pads) {
    const on = pad.dataset.gesture === gesture && state.playing;
    pad.classList.toggle("is-hot", on);
    pad.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function ensureAudio() {
  if (!state.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
    state.gain = state.ctx.createGain();
    state.gain.gain.value = Number(els.volume.value);
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 1024;
    state.gain.connect(state.analyser);
    state.analyser.connect(state.ctx.destination);
  }
  if (state.ctx.state === "suspended") state.ctx.resume();
  return state.ctx;
}

function playBuffer(audio) {
  const ctx = ensureAudio();
  if (state.source) {
    try { state.source.stop(); } catch { /* already stopped */ }
    state.source = null;
  }
  const buffer = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
  buffer.copyToChannel(audio.samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.gain);
  state.source = source;
  state.startedAt = ctx.currentTime;
  state.playing = true;
  state.duration = audio.duration;
  markHot(audio.gesture);
  source.onended = () => {
    if (state.source !== source) return;
    state.playing = false;
    state.source = null;
    markHot(state.gesture);
  };
  source.start();
}

function voice(gesture, { seed = freshSeed(), velocity = 1, play = true } = {}) {
  state.gesture = gesture;
  const audio = renderCreature({ ...params(velocity), gesture }, seed);
  state.seed = audio.seed;
  state.samples = audio.samples;
  state.sampleRate = audio.sampleRate;
  state.duration = audio.duration;
  state.speciesName = audio.speciesName;
  state.moodName = audio.moodName;
  updateLabels();
  setReadout(`${gesture.toUpperCase()} · ${audio.speciesName.toUpperCase()} · SEED ${hexSeed(audio.seed)} · ${audio.duration.toFixed(2)}S`);
  if (play) playBuffer(audio);
  return audio;
}

function downloadTake(audio, index) {
  const n = index == null ? "" : `_${String(index).padStart(2, "0")}`;
  const name = `fauna-vox_${slug(audio.speciesName)}_${slug(audio.moodName)}_${audio.gesture}${n}.wav`;
  downloadWav(audio.samples, audio.sampleRate, name);
}

function exportCurrent() {
  const audio = state.samples
    ? {
      samples: state.samples,
      sampleRate: state.sampleRate,
      speciesName: state.speciesName,
      moodName: state.moodName,
      gesture: state.gesture,
      seed: state.seed,
    }
    : voice(state.gesture, { play: false });
  downloadTake(audio);
  setReadout(`WAV · ${audio.gesture.toUpperCase()} · SEED ${hexSeed(audio.seed ?? state.seed)}`);
}

async function exportBatch() {
  if (state.batching) return;
  state.batching = true;
  els.exportBatch.disabled = true;
  const gesture = state.gesture;
  const baseSeed = freshSeed();
  const files = [];
  try {
    for (let i = 0; i < 10; i++) {
      setReadout(`RENDER ${i + 1} / 10 · ${gesture.toUpperCase()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const audio = renderCreature({ ...params(), gesture }, (baseSeed + i * 9973) >>> 0);
      const name = `fauna-vox_${slug(audio.speciesName)}_${slug(audio.moodName)}_${gesture}_${String(i + 1).padStart(2, "0")}.wav`;
      files.push({ name, data: encodeWav(audio.samples, audio.sampleRate) });
    }
    const zipName = files[0].name.replace(/_01\.wav$/, "_x10.zip");
    triggerDownload(zip, zipName, "application/zip");
    setReadout(`BATCH 10 · ${gesture.toUpperCase()} · ZIP READY`);
  } catch (error) {
    setReadout(`BATCH FAILED · ${error.message || "error"}`);
  } finally {
    state.batching = false;
    els.exportBatch.disabled = false;
  }
}

function applyPreset(preset) {
  els.size.value = String(preset.size);
  els.mood.value = String(preset.mood);
  els.species.value = String(preset.species);
  els.roughness.value = String(preset.roughness);
  els.presetName.value = preset.name;
  updateLabels();
  setReadout(`PRESET · ${preset.name.toUpperCase()}`);
}

function fillPresets() {
  const current = els.preset.value;
  els.preset.replaceChildren();
  const manual = document.createElement("option");
  manual.value = "";
  manual.textContent = "Manual";
  els.preset.append(manual);
  const factoryGroup = document.createElement("optgroup");
  factoryGroup.label = "Bench";
  state.factory.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = `factory:${index}`;
    option.textContent = preset.name;
    factoryGroup.append(option);
  });
  els.preset.append(factoryGroup);
  const stored = loadStoredPresets(STORE_KEY);
  if (stored.length) {
    const group = document.createElement("optgroup");
    group.label = "This browser";
    stored.forEach((preset, index) => {
      const option = document.createElement("option");
      option.value = `user:${index}`;
      option.textContent = preset.name;
      group.append(option);
    });
    els.preset.append(group);
  }
  if ([...els.preset.options].some((option) => option.value === current)) els.preset.value = current;
}

function selectedPreset() {
  const [kind, indexText] = els.preset.value.split(":");
  const index = Number(indexText);
  if (kind === "user") return loadStoredPresets(STORE_KEY)[index];
  return state.factory[index];
}

function savePreset() {
  const preset = {
    name: els.presetName.value.trim() || "Untitled",
    size: Number(els.size.value),
    mood: Number(els.mood.value),
    species: Number(els.species.value),
    roughness: Number(els.roughness.value),
  };
  const stored = loadStoredPresets(STORE_KEY).filter((entry) => entry.name !== preset.name);
  stored.unshift(preset);
  storePresets(STORE_KEY, stored.slice(0, 24));
  downloadJson(preset);
  fillPresets();
  els.preset.value = "user:0";
  setReadout(`SAVED · ${preset.name.toUpperCase()}`);
}

function restorePanel() {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    if (!raw) return;
    const panel = JSON.parse(raw);
    for (const key of ["size", "mood", "species", "roughness", "volume"]) {
      if (panel[key] != null && els[key]) els[key].value = panel[key];
    }
  } catch { /* ignore broken storage */ }
}

function gestureForNote(note) {
  if (note >= 60 && note <= 64) return GESTURES[note - 60];
  if (note >= 48 && note <= 52) return GESTURES[note - 48];
  return null;
}

const meterLamps = [...els.meter.children];
const scopeData = new Uint8Array(1024);

function measureMouth() {
  if (!state.playing || !state.analyser) {
    const idle = 0.06 + Math.sin(performance.now() / 700) * 0.03;
    state.mouth += (idle - state.mouth) * 0.12;
    return state.mouth;
  }
  state.analyser.getByteTimeDomainData(scopeData);
  let peak = 0;
  for (let i = 0; i < scopeData.length; i++) {
    const mag = Math.abs(scopeData[i] - 128) / 128;
    if (mag > peak) peak = mag;
  }
  state.mouth += (Math.min(1, peak * 1.4) - state.mouth) * 0.45;
  return state.mouth;
}

function updateMeter(level) {
  const lights = Math.round(Math.min(1, level * 1.3) * meterLamps.length);
  meterLamps.forEach((lamp, index) => {
    lamp.classList.toggle("on", index < lights);
    lamp.classList.toggle("hot", index >= 8 && index < lights);
    lamp.classList.toggle("clip", index >= 11 && index < lights);
  });
}

function drawMonitor() {
  const canvas = els.scope;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.floor(rect.width * dpr));
  const h = Math.max(2, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#07110c";
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.5, w * 0.65);
  glow.addColorStop(0, "rgba(40, 70, 30, 0.35)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0.5)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(150, 180, 100, 0.13)";
  ctx.lineWidth = 1;
  const grid = 22 * dpr;
  for (let x = grid; x < w; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = grid; y < h; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const species = Number(els.species.value);
  const mood = Number(els.mood.value);
  const layers = speciesLayers(species);
  ctx.save();
  ctx.strokeStyle = "rgba(183, 209, 122, 0.9)";
  ctx.fillStyle = "rgba(183, 209, 122, 0.14)";
  ctx.lineWidth = Math.max(2, dpr * 1.6);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const [index, alpha] of layers) {
    ctx.globalAlpha = alpha;
    drawSpecies(ctx, index, w / 2, h * 0.46, Math.min(w, h) * 0.34, state.mouth, mood);
  }
  ctx.restore();

  if (state.samples) {
    const samples = state.samples;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 176, 58, 0.92)";
    ctx.lineWidth = Math.max(1, dpr);
    const mid = h * 0.72;
    const amp = h * 0.22;
    for (let px = 0; px < w; px++) {
      const a = Math.floor((px / w) * samples.length);
      const b = Math.max(a + 1, Math.floor(((px + 1) / w) * samples.length));
      let min = 1;
      let max = -1;
      for (let i = a; i < b && i < samples.length; i++) {
        const s = samples[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      ctx.moveTo(px + 0.5, mid + min * amp);
      ctx.lineTo(px + 0.5, mid + max * amp);
    }
    ctx.stroke();
    if (state.playing && state.ctx) {
      const elapsed = state.ctx.currentTime - state.startedAt;
      const head = Math.max(0, Math.min(1, elapsed / state.duration));
      ctx.fillStyle = "rgba(255, 236, 200, 0.85)";
      ctx.fillRect(head * w, h * 0.56, Math.max(1, dpr), h * 0.34);
    }
  }
  ctx.fillStyle = "rgba(0, 0, 0, 0.09)";
  for (let y = 0; y < h; y += 3 * dpr) ctx.fillRect(0, y, w, dpr);
}

function speciesLayers(value) {
  const span = SPECIES.length - 1;
  const x = Math.min(span, Math.max(0, value * span));
  if (x >= span - 0.04) return [[span, 1]];
  const i = Math.floor(x);
  const frac = x - i;
  if (frac < 0.08) return [[i, 1]];
  if (frac > 0.92) return [[i + 1, 1]];
  return [[i, 1 - frac], [i + 1, frac]].sort((a, b) => a[1] - b[1]);
}

function drawSpecies(ctx, index, cx, cy, s, mouth, mood) {
  ctx.save();
  ctx.translate(cx, cy);
  if (index === 0) drawBeast(ctx, s, mouth, mood);
  else if (index === 1) drawBird(ctx, s, mouth);
  else if (index === 2) drawInsect(ctx, s, mouth);
  else if (index === 3) drawRobot(ctx, s, mouth);
  else drawSlime(ctx, s, mouth);
  ctx.restore();
}

function drawBeast(ctx, s, mouth, mood) {
  ctx.beginPath();
  ctx.moveTo(-s * 0.32, -s * 0.02);
  ctx.lineTo(-s * 0.5, -s * 0.48);
  ctx.lineTo(-s * 0.1, -s * 0.22);
  ctx.moveTo(s * 0.32, -s * 0.02);
  ctx.lineTo(s * 0.5, -s * 0.48);
  ctx.lineTo(s * 0.1, -s * 0.22);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -s * 0.02, s * 0.38, s * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, s * 0.16 + mouth * s * 0.16, s * 0.24, s * 0.1 + mouth * s * 0.1, 0, 0.15, Math.PI - 0.15);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-s * 0.12, s * 0.18);
  ctx.quadraticCurveTo(-s * 0.2, s * 0.32 + mouth * s * 0.2, -s * 0.08, s * 0.4 + mouth * s * 0.16);
  ctx.moveTo(s * 0.12, s * 0.18);
  ctx.quadraticCurveTo(s * 0.2, s * 0.32 + mouth * s * 0.2, s * 0.08, s * 0.4 + mouth * s * 0.16);
  ctx.stroke();
  const eye = s * (0.035 + (mood < 0.5 ? 0.02 : 0));
  ctx.beginPath();
  ctx.ellipse(-s * 0.14, -s * 0.04, s * 0.055, eye, -0.3, 0, Math.PI * 2);
  ctx.ellipse(s * 0.14, -s * 0.04, s * 0.055, eye, 0.3, 0, Math.PI * 2);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

function drawBird(ctx, s, mouth) {
  ctx.beginPath();
  ctx.moveTo(-s * 0.05, -s * 0.28);
  ctx.lineTo(0, -s * 0.55);
  ctx.lineTo(s * 0.08, -s * 0.3);
  ctx.moveTo(-s * 0.16, -s * 0.2);
  ctx.lineTo(-s * 0.08, -s * 0.42);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.28, s * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s * 0.18, -s * 0.02);
  ctx.lineTo(s * 0.52, -s * 0.08 - mouth * s * 0.08);
  ctx.lineTo(s * 0.2, s * 0.04);
  ctx.moveTo(s * 0.18, s * 0.06);
  ctx.lineTo(s * 0.48, s * 0.1 + mouth * s * 0.16);
  ctx.lineTo(s * 0.18, s * 0.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-s * 0.08, -s * 0.04, s * 0.045, 0, Math.PI * 2);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
}

function drawInsect(ctx, s, mouth) {
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.34);
  ctx.lineTo(-s * 0.46, -s * 0.62);
  ctx.moveTo(0, -s * 0.34);
  ctx.lineTo(s * 0.46, -s * 0.62);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-s * 0.46, -s * 0.62, s * 0.035, 0, Math.PI * 2);
  ctx.arc(s * 0.46, -s * 0.62, s * 0.035, 0, Math.PI * 2);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    const px = Math.cos(a) * s * 0.32;
    const py = Math.sin(a) * s * 0.28;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-s * 0.1, -s * 0.02, s * 0.07, 0, Math.PI * 2);
  ctx.arc(s * 0.1, -s * 0.02, s * 0.07, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-s * 0.08, s * 0.16);
  ctx.lineTo(-s * 0.22 - mouth * s * 0.12, s * 0.32);
  ctx.moveTo(s * 0.08, s * 0.16);
  ctx.lineTo(s * 0.22 + mouth * s * 0.12, s * 0.32);
  ctx.stroke();
}

function drawRobot(ctx, s, mouth) {
  roundRect(ctx, -s * 0.36, -s * 0.32, s * 0.72, s * 0.64, s * 0.06);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.32);
  ctx.lineTo(0, -s * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -s * 0.54, s * 0.045, 0, Math.PI * 2);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.fillRect(-s * 0.24, -s * 0.06, s * 0.48, s * (0.08 + mouth * 0.16));
  ctx.strokeRect(-s * 0.24, -s * 0.08, s * 0.48, s * 0.22);
  ctx.fillRect(-s * 0.28, s * 0.22, s * 0.08, s * 0.08);
  ctx.fillRect(s * 0.2, s * 0.22, s * 0.08, s * 0.08);
}

function drawSlime(ctx, s, mouth) {
  ctx.beginPath();
  ctx.ellipse(0, s * 0.08, s * 0.4, s * 0.28 + mouth * s * 0.04, 0, 0, Math.PI * 2);
  ctx.ellipse(-s * 0.02, -s * 0.16, s * 0.24, s * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(s * 0.22, s * 0.32 + mouth * s * 0.12, s * 0.07, s * 0.12, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(-s * 0.1, -s * 0.08, s * 0.05, s * 0.07, 0, 0, Math.PI * 2);
  ctx.ellipse(s * 0.1, -s * 0.06, s * 0.05, s * 0.07, 0, 0, Math.PI * 2);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, s * 0.08, s * (0.08 + mouth * 0.1), s * (0.03 + mouth * 0.06), 0, 0, Math.PI * 2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function frame() {
  const mouth = measureMouth();
  updateMeter(state.playing ? mouth : mouth * 0.4);
  drawMonitor();
  if (state.playing) markHot(state.gesture);
  requestAnimationFrame(frame);
}

for (const pad of els.pads) {
  pad.addEventListener("click", () => voice(pad.dataset.gesture));
}

for (const id of ["size", "mood", "species", "roughness", "volume"]) {
  els[id].addEventListener("input", () => {
    if (id !== "volume") els.preset.value = "";
    updateLabels();
  });
}

document.querySelector("#exportOne").addEventListener("click", exportCurrent);
els.exportBatch.addEventListener("click", () => { exportBatch(); });
document.querySelector("#savePreset").addEventListener("click", savePreset);
document.querySelector("#importPreset").addEventListener("click", () => {
  document.querySelector("#importFile").click();
});
document.querySelector("#importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const preset = parsePreset(await file.text());
    applyPreset(preset);
    const stored = loadStoredPresets(STORE_KEY).filter((entry) => entry.name !== preset.name);
    stored.unshift(preset);
    storePresets(STORE_KEY, stored.slice(0, 24));
    fillPresets();
    els.preset.value = "user:0";
  } catch (error) {
    setReadout(`IMPORT FAILED · ${error.message || "bad json"}`);
  }
});
els.preset.addEventListener("change", () => {
  const preset = selectedPreset();
  if (preset) applyPreset(preset);
});

bindKeys({
  KeyQ: () => voice("idle"),
  Digit1: () => voice("idle"),
  KeyW: () => voice("attack"),
  Digit2: () => voice("attack"),
  KeyE: () => voice("hurt"),
  Digit3: () => voice("hurt"),
  KeyR: () => voice("death"),
  Digit4: () => voice("death"),
  KeyT: () => voice("talk"),
  Digit5: () => voice("talk"),
  Space: () => voice(state.gesture),
  BracketLeft: () => stepSpecies(-1),
  BracketRight: () => stepSpecies(1),
});

function stepSpecies(dir) {
  const index = Math.round(Number(els.species.value) * (SPECIES.length - 1));
  const next = Math.min(SPECIES.length - 1, Math.max(0, index + dir));
  els.species.value = String(next / (SPECIES.length - 1));
  els.preset.value = "";
  updateLabels();
}

let stopMidi = null;
els.midi.addEventListener("click", async () => {
  if (stopMidi) return;
  els.midi.disabled = true;
  stopMidi = await bindMidiPerformance({
    onNote: ({ note, velocity }) => {
      const gesture = gestureForNote(note);
      if (gesture) voice(gesture, { velocity });
    },
    onCC: ({ controller, value }) => {
      if (controller === 20) els.size.value = String(value);
      else if (controller === 21) els.mood.value = String(value);
      else if (controller === 22) els.species.value = String(value);
      else if (controller === 23 || controller === 1) els.roughness.value = String(value);
      else if (controller === 7) els.volume.value = String(value);
      else return;
      if (controller !== 7) els.preset.value = "";
      updateLabels();
    },
    onStatus: (status) => {
      els.midi.textContent = status.available ? "MIDI on" : "MIDI off";
      setReadout(status.message ? status.message.toUpperCase() : "MIDI");
    },
  });
  els.midi.disabled = false;
});

restorePanel();
updateLabels();
setReadout("READY · PRESS A GESTURE");

const factoryUrl = new URL("../presets/factory.json", import.meta.url);
fetch(factoryUrl)
  .then((response) => response.json())
  .then((factory) => {
    state.factory = factory.map((entry) => parsePreset(JSON.stringify(entry)));
    fillPresets();
  })
  .catch(() => setReadout("PRESETS UNREADABLE"));

requestAnimationFrame(frame);
