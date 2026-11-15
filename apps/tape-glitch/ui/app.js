import {
  RANGES,
  defaultPreset,
  makeDemoReel,
  printGestures,
  randomizePreset,
  render,
  resample,
  sanitizePreset,
} from "../engine.js";
import { downloadWavChannels } from "../../../shared/wav-export.js";
import { bindKeys as bindKeyDown, bindMidiPerformance, supportsMidi } from "../../../shared/keys-and-midi-input.js";
import { openSession } from "./session.js";

const STORE = "atelier.tape-glitch.user-presets";
const PADS = [
  ["wow", "Q", "KeyQ", "Wow", "slow drift", false],
  ["flutter", "W", "KeyW", "Flutter", "fast scrape", false],
  ["stop", "A", "KeyA", "Stop", "tape halt", true],
  ["start", "S", "KeyS", "Start", "spin up", false],
  ["stutter", "D", "KeyD", "Stutter", "repeat slice", false],
  ["reverse", "R", "KeyR", "Reverse", "run backward", false],
  ["crush", "C", "KeyC", "Crush", "bit reduce", false],
  ["dropout", "X", "KeyX", "Dropout", "oxide gaps", false],
];
const KNOBS = [
  ["wowDepth", "Wow", (value) => `${(value * 100).toFixed(1)}%`],
  ["wowRate", "Wow Hz", (value) => value.toFixed(2)],
  ["flutterDepth", "Flutter", (value) => `${(value * 100).toFixed(1)}%`],
  ["flutterRate", "Flut Hz", (value) => value.toFixed(1)],
  ["stopTime", "Stop", (value) => `${value.toFixed(2)}s`],
  ["startTime", "Start", (value) => `${value.toFixed(2)}s`],
  ["stutterMs", "Slice", (value) => `${Math.round(value)} ms`],
  ["crushBits", "Bits", (value) => `${Math.round(value)}`],
  ["crushHold", "Hold", (value) => `${Math.round(value)}`],
  ["dropoutRate", "Drops", (value) => value.toFixed(1)],
  ["dropoutMs", "Gap", (value) => `${Math.round(value)} ms`],
  ["dropoutDepth", "Depth", (value) => `${Math.round(value * 100)}%`],
  ["gain", "Level", (value) => value.toFixed(2)],
];
const KEY_MAP = {
  Space: "roll",
  KeyZ: "random",
  Escape: "panic",
  KeyV: "scratch",
};
const NOTE_MAP = {
  36: "wow",
  37: "flutter",
  38: "stop",
  39: "start",
  40: "stutter",
  41: "reverse",
  42: "crush",
  43: "dropout",
  48: "scratch",
};
const CC_MAP = {
  16: "wowDepth",
  17: "wowRate",
  18: "flutterDepth",
  19: "flutterRate",
  20: "stopTime",
  21: "startTime",
  22: "stutterMs",
  23: "crushBits",
  24: "crushHold",
  25: "dropoutRate",
  26: "dropoutMs",
  27: "dropoutDepth",
  7: "gain",
};

for (const pad of PADS) KEY_MAP[pad[2]] = pad[0];

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const els = {
  pads: document.querySelector("#pads"),
  knobs: document.querySelector("#knobs"),
  roll: document.querySelector("#roll"),
  load: document.querySelector("#load"),
  file: document.querySelector("#file"),
  midi: document.querySelector("#midi"),
  status: document.querySelector("#status"),
  clock: document.querySelector("#clock"),
  wave: document.querySelector("#wave"),
  drop: document.querySelector("#drop"),
  reelName: document.querySelector("#reel-name"),
  reelHint: document.querySelector("#reel-hint"),
  scratch: document.querySelector("#scratch"),
  scratchHead: document.querySelector("#scratch-head"),
  scratchRead: document.querySelector("#scratch-read"),
  preset: document.querySelector("#preset"),
  presetName: document.querySelector("#preset-name"),
  random: document.querySelector("#random"),
  save: document.querySelector("#save"),
  importBtn: document.querySelector("#import"),
  presetFile: document.querySelector("#preset-file"),
  exportBtn: document.querySelector("#export"),
  clearTake: document.querySelector("#clear-take"),
  ledRoll: document.querySelector("#led-roll"),
  ledRec: document.querySelector("#led-rec"),
  vuL: document.querySelector("#vu-l"),
  vuR: document.querySelector("#vu-r"),
};

const padButtons = new Map();
const knobButtons = new Map();
const held = new Set();
let factory = [defaultPreset()];
let userPresets = loadUserPresets();
let preset = sanitizePreset(factory[0]);
let reel = makeDemoReel(44100);
let peaks = buildPeaks(reel.channels[0], 640);
let ctx = null;
let session = null;
let opening = null;
let rolling = false;
let pointerScratch = false;
let keyScratch = false;
let arrowScratch = false;
let midiScratch = false;
let scratchValue = 0;
let displayHead = 0;
let angle = 0;
let lastHead = 0;
let meter = { peakL: 0, peakR: 0, take: 0, capped: false };
let levelL = 0;
let levelR = 0;

function say(text) {
  els.status.textContent = text;
}

function buildPeaks(channel, buckets) {
  const mins = new Float32Array(buckets);
  const maxs = new Float32Array(buckets);
  const total = channel.length;
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * total) / buckets);
    const end = Math.max(start + 1, Math.floor(((i + 1) * total) / buckets));
    let lo = 1;
    let hi = -1;
    for (let j = start; j < end && j < total; j++) {
      const value = channel[j];
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    mins[i] = lo;
    maxs[i] = hi;
  }
  return { mins, maxs, buckets };
}

function buildPads() {
  for (const [id, key, , name, hint, danger] of PADS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = danger ? "pad tape-pad is-stop" : "pad tape-pad";
    button.dataset.effect = id;
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = `<kbd>${key}</kbd><span class="pad-name">${name}</span><span class="pad-hint">${hint}</span>`;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      press(id, true);
    });
    const release = () => press(id, false);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    els.pads.appendChild(button);
    padButtons.set(id, button);
  }
}

function buildKnobs() {
  for (const [key, label, format] of KNOBS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "knob";
    button.dataset.key = key;
    button.setAttribute("role", "slider");
    const [min, max] = RANGES[key];
    button.setAttribute("aria-valuemin", String(min));
    button.setAttribute("aria-valuemax", String(max));
    button.innerHTML = `<span class="knob-cap"></span><span class="knob-label">${label}</span><span class="knob-val"></span>`;
    button.addEventListener("pointerdown", (event) => startKnob(event, button, key));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const span = max - min;
      const step = event.shiftKey ? span / 200 : span / 40;
      const delta = event.key === "ArrowUp" ? step : -step;
      setKnob(key, preset[key] + delta);
    });
    button.addEventListener("dblclick", () => setKnob(key, defaultPreset()[key]));
    els.knobs.appendChild(button);
    knobButtons.set(key, button);
  }
  paintKnobs();
}

function startKnob(event, button, key) {
  event.preventDefault();
  button.setPointerCapture(event.pointerId);
  const [min, max] = RANGES[key];
  const startY = event.clientY;
  const start = preset[key];
  const move = (ev) => {
    const fine = ev.shiftKey ? 0.25 : 1;
    const next = start + ((startY - ev.clientY) / 140) * (max - min) * fine;
    setKnob(key, next);
  };
  const up = () => {
    button.removeEventListener("pointermove", move);
    button.removeEventListener("pointerup", up);
  };
  button.addEventListener("pointermove", move);
  button.addEventListener("pointerup", up);
}

function paintKnobs() {
  for (const [key, , format] of KNOBS) {
    const button = knobButtons.get(key);
    const [min, max] = RANGES[key];
    const value = preset[key];
    const t = (value - min) / (max - min || 1);
    const deg = -140 + Math.min(1, Math.max(0, t)) * 280;
    button.querySelector(".knob-cap").style.setProperty("--ang", `${deg}deg`);
    button.querySelector(".knob-val").textContent = format(value);
    button.setAttribute("aria-valuenow", String(Math.round(value * 1000) / 1000));
    button.setAttribute("aria-valuetext", format(value));
  }
}

function setKnob(key, value) {
  preset = sanitizePreset({ ...preset, [key]: value });
  paintKnobs();
  session?.setPreset(preset);
}

function paintPads() {
  for (const [id] of PADS) {
    padButtons.get(id).setAttribute("aria-pressed", held.has(id) ? "true" : "false");
  }
}

async function ensure() {
  if (session) {
    if (ctx.state === "suspended") await ctx.resume();
    return session;
  }
  if (!opening) {
    opening = startAudio().catch((error) => {
      opening = null;
      say(error?.message || "Audio didn't start.");
      throw error;
    });
  }
  return opening;
}

async function startAudio() {
  if (!ctx) ctx = new AudioContext();
  if (reel.sampleRate !== ctx.sampleRate) {
    reel = {
      ...reel,
      channels: resample(reel.channels, reel.sampleRate, ctx.sampleRate),
      sampleRate: ctx.sampleRate,
    };
    peaks = buildPeaks(reel.channels[0], 640);
  }
  session = await openSession(ctx, {
    channels: reel.channels,
    preset,
    onMeter: (message) => {
      meter = message;
    },
  });
  session.setRolling(rolling);
  for (const name of held) session.hold(name, true);
  if (pointerScratch || keyScratch || midiScratch) session.setScratch(scratchValue);
  return session;
}

async function press(name, down) {
  if (down) held.add(name);
  else held.delete(name);
  paintPads();
  try {
    await ensure();
  } catch {
    return;
  }
  if (down && !rolling) setRolling(true);
  session.hold(name, held.has(name));
}

function setRolling(on) {
  rolling = !!on;
  els.roll.setAttribute("aria-pressed", rolling ? "true" : "false");
  els.roll.textContent = rolling ? "Halt" : "Roll";
  els.ledRoll.classList.toggle("on", rolling);
  session?.setRolling(rolling);
}

function showScratch(value) {
  const shown = Math.min(1, Math.max(0, value));
  els.scratchHead.style.left = `${shown * 100}%`;
  els.scratchRead.textContent = `head ${shown.toFixed(2)}`;
  els.scratch.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
}

function scratchLive() {
  return pointerScratch || keyScratch || arrowScratch || midiScratch;
}

async function engageScratch(value) {
  scratchValue = Math.min(1, Math.max(0, value));
  showScratch(scratchValue);
  els.scratch.classList.add("is-hot");
  try {
    await ensure();
  } catch {
    return;
  }
  session.setScratch(scratchValue);
}

function releaseScratch() {
  if (scratchLive()) return;
  displayHead = scratchValue;
  lastHead = scratchValue;
  els.scratch.classList.remove("is-hot");
  session?.setScratch(null);
}

function refillPresets(selected) {
  els.preset.replaceChildren();
  const deck = document.createElement("optgroup");
  deck.label = "Deck";
  factory.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = `f:${index}`;
    option.textContent = item.name;
    deck.appendChild(option);
  });
  els.preset.appendChild(deck);
  if (userPresets.length) {
    const yours = document.createElement("optgroup");
    yours.label = "Yours";
    userPresets.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = `u:${index}`;
      option.textContent = item.name || `User ${index + 1}`;
      yours.appendChild(option);
    });
    els.preset.appendChild(yours);
  }
  if (selected) els.preset.value = selected;
}

function applyPreset(next, selectValue) {
  preset = sanitizePreset(next);
  els.presetName.value = preset.name || "";
  paintKnobs();
  session?.setPreset(preset);
  if (selectValue) {
    refillPresets(selectValue);
  }
}

function choosePreset(value) {
  const [kind, indexText] = value.split(":");
  const index = Number(indexText);
  const source = kind === "u" ? userPresets[index] : factory[index];
  if (!source) return;
  applyPreset(source, value);
  say(`Preset: ${preset.name}`);
}

function loadUserPresets() {
  try {
    const raw = localStorage.getItem(STORE);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function saveUserPresets(list) {
  localStorage.setItem(STORE, JSON.stringify(list));
}

function downloadPresetFile(preset) {
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tape-glitch-${slug(preset.name)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function slug(name) {
  return (name || "tape")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "tape";
}

async function loadBuffer(file) {
  say(`Threading ${file.name}…`);
  try {
    await ensure();
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const channels = [];
    for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i).slice());
    reel = { channels, sampleRate: audio.sampleRate, name: file.name };
    peaks = buildPeaks(reel.channels[0], 640);
    displayHead = 0;
    lastHead = 0;
    session.load(channels);
    session.setPreset(preset);
    els.reelName.textContent = file.name;
    els.reelHint.textContent = `${audio.numberOfChannels === 1 ? "Mono" : "Stereo"} · ${audio.duration.toFixed(1)}s`;
    say("Reel loaded. Hold a pad.");
  } catch (error) {
    say(error?.name === "EncodingError" ? "That file isn't a reel this browser can read." : "Couldn't load that reel.");
  }
}

async function exportWav() {
  const rate = reel.sampleRate;
  try {
    if (!session) await ensure().catch(() => null);
    if (session) {
      const take = await session.requestTake();
      if (take.samples > take.sampleRate * 0.35) {
        downloadWavChannels([take.left, take.right], take.sampleRate, `tape-glitch-${slug(preset.name)}-take.wav`);
        say(take.capped ? "Exported the last 45 seconds of the take." : `Exported ${ (take.samples / take.sampleRate).toFixed(1) }s take.`);
        return;
      }
    }
    const duration = Math.min(20, reel.channels[0].length / rate);
    const printed = render({
      channels: reel.channels,
      sampleRate: rate,
      duration,
      preset,
      gestures: printGestures(duration),
    });
    downloadWavChannels(printed.channels, rate, `tape-glitch-${slug(preset.name)}-print.wav`);
    say("No take yet — exported a scripted pass with the current trims.");
  } catch {
    say("Export failed.");
  }
}

function savePreset() {
  const name = els.presetName.value.trim() || preset.name || "User preset";
  preset = sanitizePreset({ ...preset, name });
  userPresets = userPresets.filter((item) => item.name !== name);
  userPresets.push(preset);
  saveUserPresets(userPresets);
  refillPresets(`u:${userPresets.length - 1}`);
  downloadPresetFile(preset);
  say(`Saved “${name}”.`);
}

async function importPreset(file) {
  try {
    const data = JSON.parse(await file.text());
    const parsed = sanitizePreset(Array.isArray(data) ? data[0] : data);
    if (!parsed.name) parsed.name = file.name.replace(/\.json$/i, "");
    userPresets = userPresets.filter((item) => item.name !== parsed.name);
    userPresets.push(parsed);
    saveUserPresets(userPresets);
    applyPreset(parsed, `u:${userPresets.length - 1}`);
    say(`Loaded “${parsed.name}”.`);
  } catch {
    say("That JSON isn't a preset.");
  }
}

function randomise() {
  preset = randomizePreset(preset);
  els.presetName.value = preset.name;
  paintKnobs();
  session?.setPreset(preset);
  say("Trims randomised. Save JSON if you want to keep them.");
}

function panic() {
  for (const name of [...held]) {
    held.delete(name);
    session?.hold(name, false);
  }
  pointerScratch = false;
  keyScratch = false;
  arrowScratch = false;
  midiScratch = false;
  paintPads();
  releaseScratch();
  say("All holds released.");
}

function allowKey(event) {
  const tag = event.target?.tagName;
  return tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT";
}

function bindKeys() {
  const downs = {};
  for (const [code, action] of Object.entries(KEY_MAP)) {
    downs[code] = () => {
      if (action === "roll") {
        ensure().then(() => setRolling(!rolling)).catch(() => {});
        return;
      }
      if (action === "random") {
        randomise();
        return;
      }
      if (action === "panic") {
        panic();
        return;
      }
      if (action === "scratch") {
        keyScratch = true;
        engageScratch(displayHead);
        return;
      }
      press(action, true);
    };
  }
  bindKeyDown(downs, window);
  window.addEventListener("keydown", (event) => {
    if (!allowKey(event)) return;
    if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
    if (!keyScratch && event.target !== els.scratch) return;
    event.preventDefault();
    arrowScratch = true;
    const step = event.shiftKey ? 0.002 : 0.01;
    const next = scratchValue + (event.code === "ArrowRight" ? step : -step);
    engageScratch(next);
  });
  window.addEventListener("keyup", (event) => {
    if (!allowKey(event)) return;
    const action = KEY_MAP[event.code];
    if (action === "scratch") {
      keyScratch = false;
      releaseScratch();
    } else if (PADS.some((pad) => pad[0] === action)) {
      press(action, false);
    }
    if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
    if (!arrowScratch) return;
    arrowScratch = false;
    releaseScratch();
  });
  window.addEventListener("blur", panic);
}

function bindScratchPad() {
  const at = (event) => {
    const rect = els.scratch.getBoundingClientRect();
    return (event.clientX - rect.left) / Math.max(1, rect.width);
  };
  els.scratch.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    els.scratch.setPointerCapture(event.pointerId);
    pointerScratch = true;
    engageScratch(at(event));
  });
  els.scratch.addEventListener("pointermove", (event) => {
    if (!pointerScratch) return;
    engageScratch(at(event));
  });
  const end = () => {
    if (!pointerScratch) return;
    pointerScratch = false;
    releaseScratch();
  };
  els.scratch.addEventListener("pointerup", end);
  els.scratch.addEventListener("pointercancel", end);
}

async function enableMidi() {
  if (!supportsMidi()) {
    els.midi.disabled = true;
    say("This browser has no Web MIDI.");
    return;
  }
  try {
    await ensure();
    await bindMidiPerformance({
      onNote({ note }) {
        const action = NOTE_MAP[note];
        if (!action) return;
        if (action === "scratch") {
          midiScratch = true;
          engageScratch(scratchValue || displayHead);
          return;
        }
        press(action, true);
      },
      onNoteOff({ note }) {
        const action = NOTE_MAP[note];
        if (!action) return;
        if (action === "scratch") {
          midiScratch = false;
          releaseScratch();
          return;
        }
        press(action, false);
      },
      onCC({ controller, value }) {
        if (controller === 1 && midiScratch) {
          engageScratch(value);
          return;
        }
        const key = CC_MAP[controller];
        if (!key) return;
        const [min, max] = RANGES[key];
        setKnob(key, min + value * (max - min));
      },
      onPitchBend({ bend }) {
        if (midiScratch) engageScratch((bend + 1) / 2);
      },
      onStatus({ available, message }) {
        els.midi.textContent = available ? "MIDI on" : "No MIDI";
        if (!available) els.midi.disabled = true;
        say(message);
      },
    });
    els.midi.disabled = true;
  } catch {
    say("MIDI permission was blocked.");
  }
}

function bindFiles() {
  els.load.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", () => {
    const file = els.file.files?.[0];
    if (file) loadBuffer(file);
    els.file.value = "";
  });
  const stop = (event) => {
    event.preventDefault();
    els.drop.classList.toggle("is-hot", event.type === "dragover");
  };
  window.addEventListener("dragover", stop);
  window.addEventListener("dragleave", (event) => {
    if (event.target === document.documentElement) els.drop.classList.remove("is-hot");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    els.drop.classList.remove("is-hot");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.type.includes("json") || file.name.endsWith(".json")) importPreset(file);
    else loadBuffer(file);
  });
}

function drawReel(context, x, y, radius, rotation) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fillStyle = "#1a140f";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#8a5a32";
  context.stroke();
  context.beginPath();
  context.arc(0, 0, radius * 0.28, 0, Math.PI * 2);
  context.fillStyle = "#e24b32";
  context.fill();
  context.strokeStyle = "#c9894a";
  context.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    context.rotate((Math.PI * 2) / 3);
    context.beginPath();
    context.moveTo(radius * 0.34, 0);
    context.lineTo(radius * 0.86, 0);
    context.stroke();
  }
  context.restore();
}

function draw() {
  const canvas = els.wave;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 640;
  const height = canvas.clientHeight || 240;
  const pixelW = Math.max(1, Math.floor(width * dpr));
  const pixelH = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#090807";
  context.fillRect(0, 0, width, height);

  const head = scratchLive() ? scratchValue : displayHead;
  let delta = head - lastHead;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  if (!reduced) angle += delta * Math.PI * 12;
  lastHead = head;

  const reelY = height * 0.36;
  const radius = Math.min(width, height) * 0.2;
  drawReel(context, width * 0.2, reelY, radius, angle);
  drawReel(context, width * 0.8, reelY, radius, -angle * 0.97);
  context.strokeStyle = "#6a432c";
  context.lineWidth = Math.max(2, radius * 0.08);
  context.beginPath();
  context.moveTo(width * 0.2 + radius * 0.2, reelY + radius * 0.15);
  context.bezierCurveTo(width * 0.38, reelY + radius * 0.85, width * 0.62, reelY + radius * 0.85, width * 0.8 - radius * 0.2, reelY + radius * 0.15);
  context.stroke();

  const top = height * 0.64;
  const mid = top + (height - top) * 0.55;
  const amp = (height - top) * 0.38;
  context.beginPath();
  context.strokeStyle = "#e8a317";
  context.lineWidth = 1.4;
  const buckets = peaks.buckets;
  for (let i = 0; i < buckets; i++) {
    const x = (i / (buckets - 1)) * width;
    context.moveTo(x, mid - peaks.maxs[i] * amp);
    context.lineTo(x, mid - peaks.mins[i] * amp);
  }
  context.stroke();
  const x = head * width;
  context.fillStyle = "rgba(226, 75, 50, 0.95)";
  context.fillRect(x, top, 2, height - top);

  const duration = reel.channels[0].length / reel.sampleRate;
  els.clock.textContent = formatClock(head * duration);
  showScratch(head);

  levelL += ((meter.peakL || 0) - levelL) * 0.35;
  levelR += ((meter.peakR || 0) - levelR) * 0.35;
  if (!scratchLive()) displayHead += ((meter.head ?? displayHead) - displayHead) * 0.35;
  els.vuL.style.transform = `scaleY(${0.08 + Math.min(1, levelL) * 0.92})`;
  els.vuR.style.transform = `scaleY(${0.08 + Math.min(1, levelR) * 0.92})`;
  const recording = (meter.take || 0) > 0 && (rolling || meter.scratching);
  els.ledRec.classList.toggle("on", recording);
  requestAnimationFrame(draw);
}

function formatClock(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

async function boot() {
  buildPads();
  buildKnobs();
  bindKeys();
  bindScratchPad();
  bindFiles();
  if (!supportsMidi()) {
    els.midi.disabled = true;
    els.midi.textContent = "No MIDI";
  }
  els.roll.addEventListener("click", () => {
    ensure().then(() => setRolling(!rolling)).catch(() => {});
  });
  els.random.addEventListener("click", randomise);
  els.save.addEventListener("click", savePreset);
  els.exportBtn.addEventListener("click", exportWav);
  els.clearTake.addEventListener("click", () => {
    session?.clearTake();
    meter = { ...meter, take: 0, capped: false };
    say("Take cleared.");
  });
  els.importBtn.addEventListener("click", () => els.presetFile.click());
  els.presetFile.addEventListener("change", () => {
    const file = els.presetFile.files?.[0];
    if (file) importPreset(file);
    els.presetFile.value = "";
  });
  els.midi.addEventListener("click", enableMidi);
  els.preset.addEventListener("change", () => choosePreset(els.preset.value));
  try {
    const response = await fetch(new URL("../presets/factory.json", import.meta.url));
    const data = await response.json();
    if (Array.isArray(data) && data.length) factory = data.map((item) => sanitizePreset(item));
  } catch {
    factory = [defaultPreset()];
  }
  refillPresets("f:0");
  applyPreset(factory[0], "f:0");
  els.reelName.textContent = reel.name;
  els.reelHint.textContent = "Demo reel — drop a file to replace it";
  requestAnimationFrame(draw);
  window.__tapeReady = true;
}

boot();
