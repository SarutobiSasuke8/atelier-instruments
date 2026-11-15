import { downloadWav, triggerDownload } from "../../../shared/wav-export.js";
import { bindKeys, bindKeyReleases, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { VOWELS, applyPatch, clamp, render, sweepPoint, timbreAt } from "../engine.js";
import { createLiveChoir } from "./audio.js";

const FACTORY = [
  ["nave.json", "Nave"],
  ["close-hum.json", "Close Hum"],
  ["glass-vowels.json", "Glass Vowels"],
  ["night-procession.json", "Night Procession"],
  ["air-chapel.json", "Air Chapel"],
  ["reed-row.json", "Reed Row"],
];

const STORAGE = "atelier.vowel-choir-pad";
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
const BLACK_AFTER = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };
const NOTE_CODES = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15,
  Semicolon: 16,
};

const patch = applyPatch({
  name: "Nave",
  vowelX: 0.5,
  vowelY: 0.78,
  choirSize: 8,
  breathiness: 0.26,
  vibrato: 0.38,
  vibratoRate: 5,
  reverb: 0.7,
  sweep: false,
  sweepRate: 0.08,
});

const els = {
  chart: document.querySelector("#chart"),
  vowel: document.querySelector("#vowelReadout"),
  formants: document.querySelector("#formants"),
  status: document.querySelector("#status"),
  piano: document.querySelector("#piano"),
  octLabel: document.querySelector("#octLabel"),
  chord: document.querySelector("#chord"),
  preset: document.querySelector("#preset"),
  sweep: document.querySelector("#sweep"),
};

const sliders = [
  ["choirSize", "choirSize", (value) => String(Math.round(value))],
  ["breathiness", "breathiness", (value) => value.toFixed(2)],
  ["vibrato", "vibrato", (value) => value.toFixed(2)],
  ["vibratoRate", "vibratoRate", (value) => value.toFixed(1)],
  ["reverb", "reverb", (value) => value.toFixed(2)],
  ["sweepRate", "sweepRate", (value) => value.toFixed(2)],
];

const holds = new Map();
const generations = new Map();
const pointers = new Map();
const codeNotes = new Map();
let ctx = null;
let live = null;
let awake = false;
let midiMessage = "Web MIDI not requested";
let statusLock = 0;
let applying = false;
let dragging = false;
let sweepPhase = 0;
let lastFrame = performance.now();
let baseMidi = 60;
let saveTimer = 0;
let meter = null;

function midiName(midi) {
  const note = Math.round(midi);
  return NAMES[((note % 12) + 12) % 12] + (Math.floor(note / 12) - 1);
}

function say(text, stickyMs = 0) {
  els.status.textContent = text;
  statusLock = stickyMs ? performance.now() + stickyMs : 0;
}

function updateStatus() {
  if (statusLock && performance.now() < statusLock) return;
  statusLock = 0;
  els.status.textContent = awake ? `Sound is live · ${midiMessage}` : "Tap a key or the map to wake the sound";
}

function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify(patch)); } catch { /* private mode */ }
  }, 160);
}

function markCustom() {
  if (applying) return;
  patch.name = "Custom";
  if (els.preset.value) els.preset.value = "";
  saveLocal();
}

function nearestPhase(x, y) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= 80; i++) {
    const point = sweepPoint(i / 80);
    const d = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i / 80;
    }
  }
  return best;
}

function paintVowel(fromSweep) {
  const timbre = timbreAt(patch.vowelX, patch.vowelY);
  const dot = els.chart.querySelector(".dot");
  dot.style.left = `${patch.vowelX * 100}%`;
  dot.style.top = `${patch.vowelY * 100}%`;
  els.vowel.textContent = timbre.label;
  els.formants.textContent = `F1 ${Math.round(timbre.f[0])}  F2 ${Math.round(timbre.f[1])}`;
  els.chart.setAttribute("aria-valuetext", `${timbre.label}, F1 ${Math.round(timbre.f[0])}, F2 ${Math.round(timbre.f[1])}`);
  for (const pin of els.chart.querySelectorAll(".pin")) {
    pin.classList.toggle("is-near", pin.dataset.id === timbre.vowel);
  }
  if (!fromSweep) markCustom();
}

let vowelStamp = 0;
function setVowel(x, y, fromSweep = false) {
  patch.vowelX = clamp(x, 0, 1);
  patch.vowelY = clamp(y, 0, 1);
  paintVowel(fromSweep);
  const now = performance.now();
  if (!fromSweep || now - vowelStamp > 40) {
    vowelStamp = now;
    live?.setVowel(patch.vowelX, patch.vowelY);
  }
}

function stopSweep() {
  if (!patch.sweep) return;
  patch.sweep = false;
  els.sweep.checked = false;
  markCustom();
}

function pushAudio() {
  live?.setMacro({
    choirSize: patch.choirSize,
    breathiness: patch.breathiness,
    vibrato: patch.vibrato,
    vibratoRate: patch.vibratoRate,
    reverb: patch.reverb,
  });
  live?.setVowel(patch.vowelX, patch.vowelY);
}

function writeControls() {
  applying = true;
  for (const [id, key, format] of sliders) {
    const input = document.querySelector(`#${id}`);
    input.value = String(patch[key]);
    input.nextElementSibling.textContent = format(Number(patch[key]));
  }
  els.sweep.checked = patch.sweep;
  setVowel(patch.vowelX, patch.vowelY, true);
  applying = false;
}

function readControls() {
  if (applying) return;
  for (const [id, key] of sliders) patch[key] = Number(document.querySelector(`#${id}`).value);
  patch.choirSize = Math.round(patch.choirSize);
  for (const [id, key, format] of sliders) {
    document.querySelector(`#${id}`).nextElementSibling.textContent = format(patch[key]);
  }
  const was = patch.sweep;
  patch.sweep = els.sweep.checked;
  if (patch.sweep && !was) sweepPhase = nearestPhase(patch.vowelX, patch.vowelY);
  markCustom();
  pushAudio();
}

function ensureAudio() {
  if (live) {
    if (ctx.state === "suspended") ctx.resume();
    return Promise.resolve(live);
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  ctx = new AudioCtx();
  live = createLiveChoir(ctx);
  meter = new Uint8Array(live.analyser.fftSize);
  pushAudio();
  awake = true;
  updateStatus();
  armMidi();
  return ctx.resume().then(() => live);
}

function paintChord() {
  const names = [...holds.keys()].sort((a, b) => a - b).map((midi) => midiName(midi));
  els.chord.textContent = names.length ? names.join(" · ") : "—";
}

function paintKeys() {
  for (const key of els.piano.querySelectorAll(".pkey")) {
    key.classList.toggle("is-down", holds.has(Number(key.dataset.midi)));
  }
  paintChord();
}

function note(midi, velocity, down) {
  if (midi < 0) {
    holds.clear();
    codeNotes.clear();
    live?.allOff();
    paintKeys();
    return;
  }
  const noteNumber = clamp(Math.round(midi), 0, 127);
  const count = holds.get(noteNumber) || 0;
  if (down) {
    holds.set(noteNumber, count + 1);
    paintKeys();
    if (count === 0) {
      const token = (generations.get(noteNumber) || 0) + 1;
      generations.set(noteNumber, token);
      ensureAudio().then(() => {
        if (generations.get(noteNumber) === token && holds.get(noteNumber) > 0) live.noteOn(noteNumber, velocity);
      });
    }
    return;
  }
  if (count <= 0) return;
  const next = count - 1;
  if (next === 0) {
    holds.delete(noteNumber);
    generations.set(noteNumber, (generations.get(noteNumber) || 0) + 1);
    live?.noteOff(noteNumber);
  } else {
    holds.set(noteNumber, next);
  }
  paintKeys();
}

function buildChart() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.classList.add("leading");
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", VOWELS.map((vowel) => `${vowel.x * 100},${vowel.y * 100}`).join(" "));
  svg.appendChild(polygon);
  const dot = document.createElement("div");
  dot.className = "dot";
  els.chart.append(svg, dot);
  for (const vowel of VOWELS) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.dataset.id = vowel.id;
    pin.textContent = vowel.label;
    pin.style.left = `${vowel.x * 100}%`;
    pin.style.top = `${vowel.y * 100}%`;
    pin.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      stopSweep();
      setVowel(vowel.x, vowel.y);
      ensureAudio();
    });
    els.chart.appendChild(pin);
  }
}

function pointFromEvent(event) {
  const rect = els.chart.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
}

function wireChart() {
  els.chart.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".pin")) return;
    dragging = true;
    els.chart.setPointerCapture(event.pointerId);
    stopSweep();
    const point = pointFromEvent(event);
    setVowel(point.x, point.y);
    ensureAudio();
  });
  els.chart.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const point = pointFromEvent(event);
    setVowel(point.x, point.y);
  });
  const endDrag = () => { dragging = false; };
  els.chart.addEventListener("pointerup", endDrag);
  els.chart.addEventListener("pointercancel", endDrag);
  els.chart.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.07 : 0.025;
    let { vowelX: x, vowelY: y } = patch;
    if (event.key === "ArrowLeft") x -= step;
    else if (event.key === "ArrowRight") x += step;
    else if (event.key === "ArrowUp") y -= step;
    else if (event.key === "ArrowDown") y += step;
    else return;
    event.preventDefault();
    stopSweep();
    setVowel(x, y);
  });
}

function wireKey(key, midi) {
  function press(event) {
    if (pointers.has(event.pointerId)) return;
    event.preventDefault();
    key.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, midi);
    note(midi, 0.92, true);
  }
  function release(event) {
    const held = pointers.get(event.pointerId);
    if (held == null) return;
    pointers.delete(event.pointerId);
    note(held, 0, false);
  }
  key.addEventListener("pointerdown", press);
  key.addEventListener("pointerup", release);
  key.addEventListener("pointercancel", release);
}

function buildPiano() {
  for (const midi of pointers.values()) note(midi, 0, false);
  pointers.clear();
  const octaves = window.innerWidth < 760 ? 1 : 2;
  const whiteCount = octaves * 7;
  const whites = document.createElement("div");
  whites.className = "whites";
  const blacks = document.createElement("div");
  blacks.className = "blacks";
  for (let step = 0; step < octaves * 12; step++) {
    const midi = baseMidi + step;
    const pc = step % 12;
    if (WHITE.has(pc)) {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "pkey white";
      key.dataset.midi = String(midi);
      key.textContent = pc === 0 ? midiName(midi) : "";
      key.setAttribute("aria-label", midiName(midi));
      whites.appendChild(key);
      wireKey(key, midi);
    } else if (BLACK_AFTER[pc] != null) {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "pkey black";
      key.dataset.midi = String(midi);
      const whitePos = Math.floor(step / 12) * 7 + BLACK_AFTER[pc];
      key.style.left = `calc(${(whitePos / whiteCount) * 100}% - 17px)`;
      key.setAttribute("aria-label", midiName(midi));
      blacks.appendChild(key);
      wireKey(key, midi);
    }
  }
  els.piano.replaceChildren(whites, blacks);
  els.octLabel.textContent = `${midiName(baseMidi)} – ${midiName(baseMidi + octaves * 12 - 1)}`;
  paintKeys();
}

function applyLoaded(raw) {
  const next = applyPatch(raw);
  Object.assign(patch, next);
  if (patch.sweep) sweepPhase = nearestPhase(patch.vowelX, patch.vowelY);
  writeControls();
  pushAudio();
  saveLocal();
  say(`Loaded ${patch.name}`, 1800);
}

async function loadFactory(file) {
  const response = await fetch(`./presets/${file}`);
  if (!response.ok) throw new Error("That preset is missing");
  applyLoaded(await response.json());
}

function fillPresets() {
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "Custom";
  els.preset.appendChild(custom);
  for (const [file, label] of FACTORY) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = label;
    els.preset.appendChild(option);
  }
}

function restore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE) || "null"); } catch { saved = null; }
  if (saved && typeof saved === "object") {
    Object.assign(patch, applyPatch(saved));
    els.preset.value = "";
  } else {
    els.preset.value = "nave.json";
  }
  if (patch.sweep) sweepPhase = nearestPhase(patch.vowelX, patch.vowelY);
  writeControls();
}

function slugName(name) {
  const slug = String(name || "preset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "preset"}.json`;
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (patch.sweep && !dragging) {
    sweepPhase = (sweepPhase + dt * patch.sweepRate) % 1;
    const point = sweepPoint(sweepPhase);
    setVowel(point.x, point.y, true);
  }
  if (live && meter) {
    live.analyser.getByteTimeDomainData(meter);
    let energy = 0;
    for (let i = 0; i < meter.length; i++) {
      const sample = (meter[i] - 128) / 128;
      energy += sample * sample;
    }
    const glow = Math.min(1, Math.sqrt(energy / meter.length) * 9);
    els.vowel.style.boxShadow = glow > 0.04 ? `inset 0 0 12px rgba(0,0,0,0.45), 0 0 ${6 + glow * 10}px rgba(183, 209, 122, ${0.25 + glow * 0.4})` : "";
  }
  requestAnimationFrame(frame);
}

const downBindings = {};
const upBindings = {};
for (const [code, semi] of Object.entries(NOTE_CODES)) {
  downBindings[code] = () => {
    if (codeNotes.has(code)) return;
    const midi = clamp(baseMidi + semi, 0, 127);
    codeNotes.set(code, midi);
    note(midi, 0.9, true);
  };
  upBindings[code] = () => {
    if (!codeNotes.has(code)) return;
    const midi = codeNotes.get(code);
    codeNotes.delete(code);
    note(midi, 0, false);
  };
}
downBindings.KeyZ = () => {
  baseMidi = Math.max(36, baseMidi - 12);
  buildPiano();
};
downBindings.KeyX = () => {
  baseMidi = Math.min(96, baseMidi + 12);
  buildPiano();
};

buildChart();
wireChart();
fillPresets();
restore();
bindKeys(downBindings, window);
bindKeyReleases(upBindings, window);
window.addEventListener("blur", () => note(-1, 0, false));

document.querySelector("#octDown").addEventListener("click", () => {
  baseMidi = Math.max(36, baseMidi - 12);
  buildPiano();
});
document.querySelector("#octUp").addEventListener("click", () => {
  baseMidi = Math.min(96, baseMidi + 12);
  buildPiano();
});

for (const [id] of sliders) document.querySelector(`#${id}`).addEventListener("input", readControls);
els.sweep.addEventListener("change", readControls);
els.preset.addEventListener("change", () => {
  if (!els.preset.value) return;
  loadFactory(els.preset.value).catch((error) => say(error.message, 2400));
});

document.querySelector("#save").addEventListener("click", () => {
  const data = applyPatch(patch);
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
  triggerDownload(bytes, slugName(data.name), "application/json");
});

document.querySelector("#load-btn").addEventListener("click", () => document.querySelector("#load").click());
document.querySelector("#load").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A preset must be a JSON object");
    els.preset.value = "";
    applyLoaded(raw);
  } catch (error) {
    say(error.message || "Could not read that preset", 2600);
  }
});

document.querySelector("#panic").addEventListener("click", () => note(-1, 0, false));
document.querySelector("#bounce").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  say("Bouncing a WAV…");
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const midis = [...holds.keys()];
    const chord = midis.length ? midis : [60, 64, 67, 71];
    const audio = render({
      ...patch,
      sampleRate: 44100,
      duration: 4,
      gain: 0.9,
      seed: 11,
      notes: chord.map((midi) => ({ midi, velocity: 0.85, start: 0.05, end: 3.2 })),
    });
    const mono = new Float32Array(audio.left.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (audio.left[i] + audio.right[i]) * 0.5;
    downloadWav(mono, audio.sampleRate, "vowel-choir.wav");
    say(midis.length ? "Bounced the held chord" : "Bounced a C major seventh", 2200);
  } catch (error) {
    say(error.message || "Bounce failed", 2600);
  } finally {
    button.disabled = false;
  }
});

let midiArmed = false;
function armMidi() {
  if (midiArmed) return;
  midiArmed = true;
  bindMidiPerformance({
    onNote({ note: midi, velocity }) { note(midi, Math.max(0.05, velocity), true); },
    onNoteOff({ note: midi }) { note(midi, 0, false); },
    onStatus(status) {
      const raw = status.message || "";
      midiMessage = /permission/i.test(raw)
        ? "MIDI permission blocked"
        : raw || (status.available ? "MIDI on" : "Web MIDI unavailable");
      updateStatus();
    },
  });
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildPiano, 120);
});

buildPiano();
updateStatus();
requestAnimationFrame(frame);
document.documentElement.dataset.ready = "true";
