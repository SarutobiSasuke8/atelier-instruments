import {
  applyMode,
  createEngine,
  defaultPreset,
  makeDemoVowel,
  mergePreset,
  processBlock,
  renderVocoded,
  setVoiceBuffer,
} from "../engine.js";
import { bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";
import { downloadWav } from "../../../shared/wav-export.js";

const OFFSETS = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
  KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
  Semicolon: 15, Slash: 16, KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15,
  KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22,
  KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};
const KEYBOARD_SPAN = 29;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(note) {
  const n = ((Math.round(note) % 12) + 12) % 12;
  return NAMES[n] + (Math.floor(Math.round(note) / 12) - 1);
}

function isBlackKey(note) {
  return NAMES[((Math.round(note) % 12) + 12) % 12].includes("#");
}

function slug(name) {
  return String(name || "preset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
}

function downloadPresetJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug(data.name)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function readPresetFile(file) {
  const data = JSON.parse(await file.text());
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Preset must be a JSON object");
  return data;
}

const statusEl = document.querySelector("#status");
const notesEl = document.querySelector("#notes");
const voiceNameEl = document.querySelector("#voice-name");
const meterEl = document.querySelector("#meter");
const canvas = document.querySelector("#spectrum");
const kb = document.querySelector("#kb");
const powerBtn = document.querySelector("#power");
const recordBtn = document.querySelector("#record");
const rootWrap = document.querySelector("#root-wrap");

const FORMAT = {
  formant: (v) => `${Math.round(v)} st`,
  q: (v) => Number(v).toFixed(1),
  attack: (v) => `${Math.round(v * 1000)} ms`,
  release: (v) => `${Math.round(v * 1000)} ms`,
  sibilance: (v) => `${Math.round(v * 100)}%`,
  noiseBlend: (v) => `${Math.round(v * 100)}%`,
  dryWet: (v) => `${Math.round((1 - v) * 100)}/${Math.round(v * 100)}`,
  root: (v) => noteName(Math.round(v)),
  detune: (v) => `${Math.round(v)} ct`,
  unison: (v) => String(Math.round(v)),
  gain: (v) => Number(v).toFixed(2),
  inputGain: (v) => Number(v).toFixed(2),
  chorus: (v) => `${Math.round(v * 100)}%`,
  delayMix: (v) => `${Math.round(v * 100)}%`,
  delayTime: (v) => `${Math.round(v * 1000)} ms`,
  delayFeedback: (v) => `${Math.round(v * 100)}%`,
  reverb: (v) => `${Math.round(v * 100)}%`,
  "arp.rate": (v) => `${Number(v).toFixed(1)} hz`,
  "arp.gate": (v) => `${Math.round(v * 100)}%`,
  "arp.octaves": (v) => String(Math.round(v)),
};

let preset = defaultPreset();
let writing = false;
let baseNote = 48;
let ctx = null;
let engine = null;
let processor = null;
let micStream = null;
let micNode = null;
let powered = false;
let recording = false;
let recChunks = [];
let recLength = 0;
let lastTake = null;
let activePreset = "classic-robot.json";
let voiceKind = "demo";
let fileVoice = null;
let demoVoice = null;
let displayMax = 0.05;
const peaks = [];

const sources = { keys: new Map(), pointers: new Map(), midi: new Map() };
let latch = [];
const births = new Map();

function setStatus(text) {
  statusEl.textContent = text;
}

function getPath(obj, path) {
  return path.split(".").reduce((cursor, key) => cursor[key], obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]];
  cursor[keys[keys.length - 1]] = value;
}

function decodeBuffer(audioCtx, encoded) {
  return new Promise((resolve, reject) => {
    const copy = encoded.slice(0);
    let settled = false;
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const bad = (error) => {
      if (settled) return;
      settled = true;
      reject(error || new Error("decode failed"));
    };
    const result = audioCtx.decodeAudioData(copy, ok, bad);
    if (result && typeof result.then === "function") result.then(ok, bad);
  });
}

function currentVoice() {
  if (voiceKind === "file" && fileVoice) return fileVoice;
  if (!demoVoice || (engine && demoVoice.rate !== engine.sampleRate && voiceKind === "demo")) {
    const rate = engine ? engine.sampleRate : 44100;
    demoVoice = { samples: makeDemoVowel(rate, 1.5), rate, label: "Built-in vowel" };
  }
  return demoVoice;
}

function applyVoice() {
  if (!engine) return;
  if (voiceKind === "mic") {
    engine.source = "mic";
    return;
  }
  const voice = currentVoice();
  setVoiceBuffer(engine, voice.samples, voice.rate, document.querySelector("#loop").checked);
  voiceNameEl.textContent = voice.label;
}

function pushPreset(shouldReflect = true) {
  preset = mergePreset(preset);
  if (engine) engine.preset = preset;
  if (shouldReflect) reflect();
}

function reflect() {
  writing = true;
  for (const input of document.querySelectorAll("[data-path]")) {
    const path = input.dataset.path;
    const value = getPath(preset, path);
    input.value = value;
    const out = document.querySelector(`#${input.id}-read`);
    if (out && FORMAT[path]) out.textContent = FORMAT[path](Number(value));
  }
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === preset.mode));
  }
  for (const button of document.querySelectorAll("[data-bands]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.bands) === preset.bands));
  }
  for (const button of document.querySelectorAll("[data-wave]")) {
    button.setAttribute("aria-pressed", String(button.dataset.wave === preset.wave));
  }
  const arpBtn = document.querySelector("#arp");
  arpBtn.setAttribute("aria-pressed", String(preset.arp.enabled));
  arpBtn.textContent = preset.arp.enabled ? "Arp on" : "Arp off";
  const holdBtn = document.querySelector("#hold");
  holdBtn.setAttribute("aria-pressed", String(preset.hold));
  document.querySelector("#pattern").value = preset.arp.pattern;
  rootWrap.classList.toggle("dimmed", !(preset.mode === "monotone" || preset.monotone));
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.setAttribute("aria-pressed", String(button.dataset.preset === activePreset));
  }
  const sourceButtons = {
    demo: document.querySelector("#src-demo"),
    mic: document.querySelector("#src-mic"),
    file: document.querySelector("#src-file"),
  };
  for (const [kind, button] of Object.entries(sourceButtons)) {
    const on = voiceKind === kind;
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("is-on", on);
  }
  writing = false;
  paintKeys();
}

function liveEntries() {
  const map = new Map();
  for (const source of Object.values(sources)) {
    for (const value of source.values()) {
      const prev = map.get(value.note);
      if (prev == null || value.vel > prev) map.set(value.note, value.vel);
    }
  }
  return [...map.entries()];
}

function publish() {
  let entries = liveEntries();
  if (preset.hold) {
    if (entries.length) latch = entries;
    entries = latch;
  }
  const now = engine ? engine.time : 0;
  const seen = new Set();
  const held = [];
  for (const [note, velocity] of entries) {
    seen.add(note);
    if (!births.has(note)) births.set(note, now);
    held.push({ note, velocity, onTime: births.get(note) });
  }
  for (const note of [...births.keys()]) if (!seen.has(note)) births.delete(note);
  if (engine) engine.held = held;
  const names = [...seen].sort((a, b) => a - b).map(noteName);
  notesEl.textContent = names.length ? names.join(" ") : "—";
  paintKeys(seen);
}

function paintKeys(sounding = null) {
  const active = sounding || new Set((engine && engine.held ? engine.held : []).map((note) => note.note));
  for (const key of kb.querySelectorAll(".ivory, .ebony")) {
    key.classList.toggle("is-on", active.has(Number(key.dataset.note)));
  }
}

function buildKeyboard() {
  kb.replaceChildren();
  const whites = [];
  for (let i = 0; i < KEYBOARD_SPAN; i++) {
    const note = baseNote + i;
    if (!isBlackKey(note)) whites.push(note);
  }
  const whiteCount = whites.length;
  whites.forEach((note, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ivory";
    button.dataset.note = String(note);
    button.style.position = "absolute";
    button.style.width = `${100 / whiteCount}%`;
    button.style.left = `${(index / whiteCount) * 100}%`;
    const name = noteName(note);
    const letter = name.replace(/-?\d+$/, "");
    const label = document.createElement("small");
    label.textContent = letter === "C" ? name : letter;
    button.append(label);
    button.setAttribute("aria-label", name);
    kb.append(button);
  });
  let whiteIndex = 0;
  for (let i = 0; i < KEYBOARD_SPAN; i++) {
    const note = baseNote + i;
    if (!isBlackKey(note)) {
      whiteIndex += 1;
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ebony";
    button.dataset.note = String(note);
    const width = (0.62 / whiteCount) * 100;
    button.style.width = `${width}%`;
    button.style.left = `${(whiteIndex / whiteCount) * 100}%`;
    button.style.transform = "translateX(-50%)";
    button.setAttribute("aria-label", noteName(note));
    kb.append(button);
  }
  document.querySelector("#oct-label").textContent = noteName(baseNote);
  paintKeys();
}

function noteOn(id, map, note, vel) {
  map.set(id, { note, vel });
  ensureAudio();
  publish();
}

function noteOff(id, map) {
  if (!map.has(id)) return;
  map.delete(id);
  publish();
}

function disconnectMic() {
  if (!micNode) return;
  try {
    micNode.disconnect();
  } catch {
    /* already disconnected */
  }
}

async function ensureAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      setStatus("This browser has no Web Audio.");
      return;
    }
    ctx = new AudioCtx();
    engine = createEngine(ctx.sampleRate, preset, { safe: true });
    applyVoice();
    publish();
    if (typeof ctx.createScriptProcessor !== "function") {
      setStatus("Live audio is unavailable here. Export WAV still bounces offline.");
      return;
    }
    const keeper = ctx.createGain();
    keeper.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.frequency.value = 1;
    osc.connect(keeper);
    processor = ctx.createScriptProcessor(2048, 1, 2);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.numberOfChannels > 1 ? event.outputBuffer.getChannelData(1) : null;
      processBlock(engine, engine.source === "mic" ? input : null, left);
      if (right) right.set(left);
      if (recording) {
        recChunks.push(new Float32Array(left));
        recLength += left.length;
        if (recLength >= ctx.sampleRate * 60) stopRecord(true);
      }
    };
    keeper.connect(processor);
    processor.connect(ctx.destination);
    osc.start();
  }
  if (ctx.state !== "running") await ctx.resume();
  powered = ctx.state === "running";
  powerBtn.setAttribute("aria-pressed", String(powered));
  document.documentElement.classList.toggle("is-live", powered);
  if (powered && /^(Standby|Asleep)/.test(statusEl.textContent)) {
    setStatus("Live. Play the keyboard — the vowel is the voice until you load one.");
  }
}

async function togglePower() {
  if (!ctx) {
    await ensureAudio();
    if (powered) setStatus("Live. Built-in vowel is looping through the vocoder.");
    return;
  }
  if (ctx.state === "running") {
    await ctx.suspend();
    powered = false;
    setStatus("Asleep.");
  } else {
    await ctx.resume();
    powered = true;
    setStatus("Live.");
  }
  powerBtn.setAttribute("aria-pressed", String(powered));
  document.documentElement.classList.toggle("is-live", powered);
}

async function useMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Microphone input is not available in this browser.");
    return;
  }
  const request = navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  try {
    await ensureAudio();
    if (!processor) return;
    if (!micStream) micStream = await request;
    if (!micNode) micNode = ctx.createMediaStreamSource(micStream);
    disconnectMic();
    micNode.connect(processor);
    voiceKind = "mic";
    engine.source = "mic";
    voiceNameEl.textContent = "Live microphone";
    reflect();
    setStatus("Mic live. Headphones keep the vocoder from howling.");
  } catch (error) {
    setStatus(error && error.name === "NotAllowedError" ? "Microphone permission was blocked." : "Could not open the microphone.");
  }
}

function useDemo() {
  voiceKind = "demo";
  disconnectMic();
  if (engine) {
    engine.source = "buffer";
    applyVoice();
  }
  voiceNameEl.textContent = "Built-in vowel";
  reflect();
  setStatus("Built-in vowel looping.");
}

async function useFile(file) {
  if (!file) {
    document.querySelector("#file").click();
    return;
  }
  try {
    await ensureAudio();
    const encoded = await file.arrayBuffer();
    const decoded = await decodeBuffer(ctx, encoded);
    const length = decoded.length;
    const channels = decoded.numberOfChannels;
    const samples = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < length; i++) samples[i] += data[i];
    }
    let peak = 0;
    const scale = 1 / channels;
    for (let i = 0; i < length; i++) {
      samples[i] *= scale;
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    if (peak > 0.0001) {
      const gain = 0.9 / peak;
      for (let i = 0; i < length; i++) samples[i] *= gain;
    }
    fileVoice = { samples, rate: decoded.sampleRate, label: file.name };
    voiceKind = "file";
    disconnectMic();
    setVoiceBuffer(engine, samples, decoded.sampleRate, document.querySelector("#loop").checked);
    voiceNameEl.textContent = file.name;
    reflect();
    setStatus(`Loaded ${file.name}. ${document.querySelector("#loop").checked ? "Looping." : "Playing once."}`);
  } catch {
    setStatus("Could not decode that audio file.");
  }
}

function stopRecord(auto = false) {
  recording = false;
  recordBtn.setAttribute("aria-pressed", "false");
  recordBtn.textContent = "Record";
  if (!recLength || !ctx) {
    recChunks = [];
    recLength = 0;
    return;
  }
  const samples = new Float32Array(recLength);
  let offset = 0;
  for (const chunk of recChunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  lastTake = { samples, sampleRate: ctx.sampleRate };
  recChunks = [];
  recLength = 0;
  setStatus(auto ? "Hit the 60 second limit. Take is ready to export." : "Take ready. Export WAV downloads it.");
}

function startRecord() {
  if (!engine || !processor) return;
  recording = true;
  recChunks = [];
  recLength = 0;
  lastTake = null;
  recordBtn.setAttribute("aria-pressed", "true");
  recordBtn.textContent = "Stop";
  setStatus("Recording the vocoder output.");
}

function bounceNotes(duration) {
  const held = (engine && engine.held) || [];
  if (held.length) {
    return held.map((note) => ({
      note: note.note,
      velocity: note.velocity,
      start: 0,
      duration,
    }));
  }
  return [
    { note: baseNote, start: 0, duration: duration * 0.34, velocity: 0.85 },
    { note: baseNote + 7, start: duration * 0.28, duration: duration * 0.34, velocity: 0.8 },
    { note: baseNote + 12, start: duration * 0.56, duration: duration * 0.44, velocity: 0.9 },
  ];
}

function exportAudio() {
  if (recording) stopRecord(false);
  if (lastTake) {
    downloadWav(lastTake.samples, lastTake.sampleRate, `${slug(preset.name)}.wav`);
    setStatus("Exported the recorded take.");
    return;
  }
  const voice = voiceKind === "file" && fileVoice ? fileVoice : { samples: makeDemoVowel(44100, 1.5), rate: 44100 };
  const duration = Math.min(6, Math.max(2.4, Math.min(voice.samples.length / voice.rate, 6)));
  const held = engine && engine.held && engine.held.length;
  const rendered = renderVocoded(
    { samples: voice.samples, sampleRate: voice.rate },
    bounceNotes(duration),
    preset,
    { sampleRate: 44100, duration, seed: 5 },
  );
  downloadWav(rendered.samples, rendered.sampleRate, `${slug(preset.name)}-bounce.wav`);
  setStatus(held ? "Exported an offline bounce of the held notes." : "No take yet — exported a short demo phrase.");
}

function panic() {
  sources.keys.clear();
  sources.pointers.clear();
  sources.midi.clear();
  latch = [];
  births.clear();
  if (engine) engine.held = [];
  notesEl.textContent = "—";
  paintKeys(new Set());
  setStatus("All notes off.");
}

async function loadPresetName(name, announce = true) {
  const response = await fetch(new URL(`../presets/${name}`, import.meta.url));
  if (!response.ok) throw new Error("missing preset");
  const data = await response.json();
  activePreset = name;
  preset = mergePreset(data);
  if (!preset.hold) latch = [];
  if (engine) engine.preset = preset;
  reflect();
  publish();
  if (announce) setStatus(preset.name);
}

function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 640;
  const height = 148;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  const bands = preset.bands;
  let max = 0.0008;
  for (let i = 0; i < bands; i++) {
    const level = engine ? engine.bandLevels[i] : 0;
    if (level > max) max = level;
  }
  displayMax = Math.max(max, displayMax * 0.992);
  const gap = 3;
  const barW = Math.max(2, (width - 16 - gap * bands) / bands);
  for (let i = 0; i < bands; i++) {
    const level = engine ? engine.bandLevels[i] : 0;
    const norm = Math.max(0, Math.min(1, level / displayMax));
    peaks[i] = Math.max(norm, (peaks[i] || 0) * 0.96);
    const x = 8 + i * (barW + gap);
    const h = Math.max(2, norm * (height - 28));
    g.fillStyle = "#3a2a16";
    g.fillRect(x, 18, barW, height - 26);
    g.fillStyle = i > bands * 0.82 ? "#ffb15a" : "#e6a23c";
    g.fillRect(x, 18 + (height - 28 - h), barW, h);
    const ph = Math.max(2, peaks[i] * (height - 28));
    g.fillStyle = "#ffe0ad";
    g.fillRect(x, 18 + (height - 28 - ph), barW, 2);
  }
  const peak = engine ? engine.peak : 0;
  const segments = meterEl.children;
  for (let i = 0; i < segments.length; i++) {
    const threshold = (i + 1) / segments.length;
    const on = peak >= threshold * 0.92;
    segments[i].classList.toggle("on", on);
    segments[i].classList.toggle("hot", on && i > segments.length - 3);
  }
  requestAnimationFrame(draw);
}

function bindSliders() {
  for (const input of document.querySelectorAll("[data-path]")) {
    input.addEventListener("input", () => {
      if (writing) return;
      const path = input.dataset.path;
      let value = Number(input.value);
      if (path === "unison" || path === "arp.octaves" || path === "root" || path === "formant" || path === "detune") {
        value = Math.round(value);
      }
      setPath(preset, path, value);
      activePreset = "";
      const out = document.querySelector(`#${input.id}-read`);
      if (out && FORMAT[path]) out.textContent = FORMAT[path](value);
      pushPreset(false);
    });
  }
}

function bindKeyboard() {
  const pointers = new Map();
  const keyFromPoint = (event) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    return el && el.closest ? el.closest(".ivory, .ebony") : null;
  };
  kb.addEventListener("pointerdown", (event) => {
    const key = event.target.closest(".ivory, .ebony");
    if (!key) return;
    event.preventDefault();
    kb.setPointerCapture(event.pointerId);
    const note = Number(key.dataset.note);
    pointers.set(event.pointerId, note);
    noteOn(event.pointerId, sources.pointers, note, 0.95);
  });
  kb.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const key = keyFromPoint(event);
    if (!key) return;
    const note = Number(key.dataset.note);
    if (pointers.get(event.pointerId) === note) return;
    pointers.set(event.pointerId, note);
    sources.pointers.clear();
    for (const [id, held] of pointers) sources.pointers.set(id, { note: held, vel: 0.95 });
    ensureAudio();
    publish();
  });
  const endPointer = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    noteOff(event.pointerId, sources.pointers);
  };
  kb.addEventListener("pointerup", endPointer);
  kb.addEventListener("pointercancel", endPointer);

  const heldCodes = new Map();
  const isField = (event) => {
    const el = event.target;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  };
  const down = (event) => {
    if (event.repeat || isField(event)) return;
    const offset = OFFSETS[event.code];
    if (offset == null) return;
    event.preventDefault();
    if (heldCodes.has(event.code)) return;
    const note = baseNote + offset;
    heldCodes.set(event.code, note);
    noteOn(event.code, sources.keys, note, 0.9);
  };
  const up = (event) => {
    if (!heldCodes.has(event.code)) return;
    heldCodes.delete(event.code);
    noteOff(event.code, sources.keys);
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", () => {
    for (const code of [...heldCodes.keys()]) {
      heldCodes.delete(code);
      noteOff(code, sources.keys);
    }
  });
}

function bindFiles() {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("is-drag");
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) document.body.classList.remove("is-drag");
  });
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    document.body.classList.remove("is-drag");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    if (/json$/i.test(file.name) || /json/.test(file.type)) {
      try {
        preset = mergePreset(await readPresetFile(file));
        activePreset = "";
        if (!preset.hold) latch = [];
        if (engine) engine.preset = preset;
        reflect();
        publish();
        setStatus(`Loaded preset ${preset.name}.`);
      } catch {
        setStatus("That JSON is not a preset.");
      }
      return;
    }
    useFile(file);
  });
  document.querySelector("#file").addEventListener("change", () => {
    const file = document.querySelector("#file").files[0];
    if (file) useFile(file);
  });
  document.querySelector("#drop").addEventListener("click", () => document.querySelector("#file").click());
  document.querySelector("#file-btn").addEventListener("click", () => document.querySelector("#file").click());
}

for (let i = 0; i < 12; i++) {
  const segment = document.createElement("i");
  meterEl.append(segment);
}

bindSliders();
bindKeyboard();
bindFiles();
buildKeyboard();

document.querySelector("#power").addEventListener("click", togglePower);
document.querySelector("#src-demo").addEventListener("click", useDemo);
document.querySelector("#src-mic").addEventListener("click", useMic);
document.querySelector("#src-file").addEventListener("click", () => {
  if (!fileVoice) {
    document.querySelector("#file").click();
    return;
  }
  voiceKind = "file";
  disconnectMic();
  if (engine) setVoiceBuffer(engine, fileVoice.samples, fileVoice.rate, document.querySelector("#loop").checked);
  voiceNameEl.textContent = fileVoice.label;
  reflect();
  ensureAudio();
  setStatus(`Playing ${fileVoice.label}.`);
});
document.querySelector("#loop").addEventListener("change", () => {
  if (engine && voiceKind !== "mic") engine.loop = document.querySelector("#loop").checked;
  setStatus(document.querySelector("#loop").checked ? "Vocal loop on." : "Vocal loop off.");
});
document.querySelector("#modes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  preset = applyMode(preset, button.dataset.mode);
  activePreset = "";
  if (engine) engine.preset = preset;
  reflect();
  setStatus(`${button.textContent.trim()} mode.`);
});
document.querySelector("#bands").addEventListener("click", (event) => {
  const button = event.target.closest("[data-bands]");
  if (!button) return;
  preset.bands = Number(button.dataset.bands);
  activePreset = "";
  pushPreset();
});
document.querySelector("#waves").addEventListener("click", (event) => {
  const button = event.target.closest("[data-wave]");
  if (!button) return;
  preset.wave = button.dataset.wave;
  if (preset.wave === "supersaw" && preset.unison < 5) preset.unison = 5;
  activePreset = "";
  pushPreset();
});
document.querySelector("#arp").addEventListener("click", () => {
  preset.arp.enabled = !preset.arp.enabled;
  activePreset = "";
  pushPreset();
});
document.querySelector("#hold").addEventListener("click", () => {
  preset.hold = !preset.hold;
  if (!preset.hold) latch = [];
  activePreset = "";
  pushPreset();
  publish();
});
document.querySelector("#pattern").addEventListener("change", (event) => {
  preset.arp.pattern = event.target.value;
  activePreset = "";
  pushPreset();
});
document.querySelector("#record").addEventListener("click", async () => {
  await ensureAudio();
  if (!processor) return;
  if (recording) stopRecord(false);
  else startRecord();
});
document.querySelector("#export").addEventListener("click", exportAudio);
document.querySelector("#save-preset").addEventListener("click", () => {
  downloadPresetJson(preset);
  setStatus("Preset JSON downloaded.");
});
document.querySelector("#panic").addEventListener("click", panic);
document.querySelector("#oct-down").addEventListener("click", () => {
  baseNote = Math.max(24, baseNote - 12);
  buildKeyboard();
});
document.querySelector("#oct-up").addEventListener("click", () => {
  baseNote = Math.min(72, baseNote + 12);
  buildKeyboard();
});
document.querySelector("#presets").addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  loadPresetName(button.dataset.preset).catch(() => setStatus("Could not load that preset."));
});
document.querySelector("#midi").addEventListener("click", async () => {
  try {
    await bindMidiPerformance({
      onNote: ({ note, velocity }) => noteOn(note, sources.midi, note, velocity),
      onNoteOff: ({ note }) => noteOff(note, sources.midi),
      onStatus: (info) => {
        document.querySelector("#midi-state").textContent = info.message;
        setStatus(info.available ? "MIDI input armed." : info.message);
      },
    });
  } catch {
    setStatus("MIDI permission was blocked.");
  }
});

loadPresetName("classic-robot.json", false).catch(() => {
  reflect();
});
requestAnimationFrame(draw);
setStatus("Standby. Press power, then play. The built-in vowel speaks until you drop a vocal.");
