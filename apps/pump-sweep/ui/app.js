// SPDX-License-Identifier: MIT
import {
  RATES,
  barsToSeconds,
  clamp01,
  clampBpm,
  clampCutoff,
  detectBpm,
  divisionSeconds,
  expLerp,
  gestureTargets,
  prepareParams,
  processPumpSweep,
  pumpGainAt,
  renderDemoLoop,
  resonanceToQ,
  sceneAt,
} from "../engine.js";
import { downloadWavChannels, triggerDownload } from "../../../shared/wav-export.js";
import { parseLoosePreset, presetFilename, serializeLoosePreset } from "../../../shared/presets.js";
import { bindKeyHolds, bindMidiPerformance } from "../../../shared/keys-and-midi-input.js";

const $ = (id) => document.getElementById(id);

const state = {
  bpm: 124,
  sweepBars: 4,
  output: 0.92,
  loop: true,
  pump: { enabled: true, depth: 0.75, shape: 0.62, rate: "1/4", offset: 0 },
  filter: { enabled: true, type: "lowpass", cutoff: 14000, resonance: 0.18 },
  performance: [],
  clip: null,
  clipName: "Desk loop",
  demo: true,
};

const TYPES = [
  ["lowpass", "Low"],
  ["highpass", "High"],
  ["bandpass", "Band"],
];

let sourceNode = null;
let ctx = null;
let graph = null;
let playbackBuffer = null;
let playing = false;
let playStartCtx = 0;
let playOffset = 0;
let scheduledUntil = 0;
let schedulerTimer = 0;
let hold = null;
let release = null;
let record = null;
let peaks = null;
let applying = false;
let taps = [];
let visual = 0;
const holdCounts = new Map();
const presets = new Map();

const liveScratch = {};
const releaseFrom = {};

function setStatus(text) {
  $("status").textContent = text;
}

function duration() {
  if (!state.clip) return 0;
  return state.clip.length / state.clip.sampleRate;
}

function formatClock(seconds) {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rem = (safe - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rem}`;
}

function formatHz(hz) {
  if (hz >= 1000) {
    return { text: (hz / 1000).toFixed(hz >= 10000 ? 1 : 2), unit: "kHz" };
  }
  return { text: String(Math.round(hz)), unit: "Hz" };
}

function showCutoff(hz) {
  const formatted = formatHz(hz);
  $("cutoff-value").textContent = formatted.text;
  $("cutoff-unit").textContent = formatted.unit;
}

function shapeWord(shape) {
  if (shape < 0.34) return "Soft";
  if (shape < 0.67) return "Pump";
  return "Snap";
}

function paramsFromState() {
  return prepareParams({
    bpm: state.bpm,
    output: state.output,
    pump: state.pump,
    filter: state.filter,
    performance: state.performance,
    riserSeed: 1,
  });
}

function sweepSeconds() {
  return barsToSeconds(state.bpm, state.sweepBars);
}

function ensureGraph() {
  if (graph) return graph;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("This browser has no Web Audio");
  ctx = new AC();
  const pumpGain = ctx.createGain();
  const filterNode = ctx.createBiquadFilter();
  const riserFilter = ctx.createBiquadFilter();
  const riserGain = ctx.createGain();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  filterNode.type = "lowpass";
  filterNode.frequency.value = state.filter.cutoff;
  filterNode.Q.value = resonanceToQ(state.filter.resonance);
  riserFilter.type = "bandpass";
  riserFilter.frequency.value = 800;
  riserFilter.Q.value = 4;
  riserGain.gain.value = 0;
  pumpGain.gain.value = 1;
  master.gain.value = state.output;
  filterNode.connect(pumpGain);
  pumpGain.connect(master);
  riserFilter.connect(riserGain);
  riserGain.connect(pumpGain);
  master.connect(analyser);
  analyser.connect(ctx.destination);

  const seconds = 2;
  const noise = ctx.createBuffer(1, Math.floor(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = noise.getChannelData(0);
  let seed = 0x51a7e;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = seed / 4294967296 * 2 - 1;
  }
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noise;
  noiseSource.loop = true;
  noiseSource.connect(riserFilter);
  noiseSource.start();

  graph = { pumpGain, filterNode, riserFilter, riserGain, master, analyser, noiseSource };
  return graph;
}

function toAudioBuffer(audio, clip) {
  const buffer = audio.createBuffer(clip.numberOfChannels, clip.length, clip.sampleRate);
  for (let c = 0; c < clip.numberOfChannels; c++) buffer.copyToChannel(clip.getChannelData(c), c);
  return buffer;
}

function fileTimeAt(ctxTime) {
  const dur = duration();
  if (!dur) return 0;
  if (!playing || !ctx) return ((playOffset % dur) + dur) % dur;
  const elapsed = ctxTime - playStartCtx;
  if (!state.loop) return Math.min(dur, Math.max(0, playOffset + elapsed));
  const wrapped = playOffset + elapsed;
  return ((wrapped % dur) + dur) % dur;
}

function heldForAt(ctxTime, nowCtx, nowPerf) {
  if (!hold) return 0;
  return Math.max(0, (nowPerf - hold.t0) / 1000 + (ctxTime - nowCtx));
}

function liveScene(ctxTime, nowCtx, nowPerf) {
  const base = {
    cutoff: state.filter.cutoff,
    resonance: state.filter.resonance,
    gain: 1,
    riser: 0,
    riserFreq: 1000,
    depthMul: 1,
  };
  if (hold) {
    return gestureTargets(
      {
        type: hold.type,
        heldFor: heldForAt(ctxTime, nowCtx, nowPerf),
        sweepSeconds: sweepSeconds(),
        baseCutoff: base.cutoff,
        baseResonance: base.resonance,
      },
      liveScratch,
    );
  }
  if (release) {
    const elapsed = (nowPerf - release.t0) / 1000 + (ctxTime - nowCtx);
    const u = elapsed / release.dur;
    if (u < 1) {
      liveScratch.cutoff = expLerp(release.from.cutoff, base.cutoff, u);
      liveScratch.resonance = release.from.resonance + (base.resonance - release.from.resonance) * u;
      liveScratch.gain = release.from.gain + (1 - release.from.gain) * u;
      liveScratch.riser = release.from.riser * (1 - u);
      liveScratch.riserFreq = expLerp(release.from.riserFreq, 1000, u);
      liveScratch.depthMul = release.from.depthMul + (1 - release.from.depthMul) * u;
      return liveScratch;
    }
    release = null;
  }
  if (playing && state.performance.length) {
    return sceneAt(fileTimeAt(ctxTime), paramsFromState(), liveScratch);
  }
  liveScratch.cutoff = base.cutoff;
  liveScratch.resonance = base.resonance;
  liveScratch.gain = 1;
  liveScratch.riser = 0;
  liveScratch.riserFreq = 1000;
  liveScratch.depthMul = 1;
  return liveScratch;
}

function applyFilter(now, scene) {
  const node = graph.filterNode;
  const gesture = hold && hold.type !== "cut";
  if (!state.filter.enabled && !gesture) {
    node.type = "lowpass";
    node.frequency.setTargetAtTime(19000, now, 0.02);
    node.Q.setTargetAtTime(0.707, now, 0.02);
    return;
  }
  node.type = state.filter.type;
  node.frequency.setTargetAtTime(clampCutoff(scene.cutoff, ctx.sampleRate), now, 0.012);
  node.Q.setTargetAtTime(resonanceToQ(scene.resonance), now, 0.015);
}

function reschedule() {
  if (!ctx || !graph) return;
  const now = ctx.currentTime;
  graph.pumpGain.gain.cancelScheduledValues(now);
  graph.pumpGain.gain.setValueAtTime(Math.max(0, graph.pumpGain.gain.value), now);
  graph.master.gain.setTargetAtTime(state.output, now, 0.01);
  scheduledUntil = now;
  if (playing) {
    clearTimeout(schedulerTimer);
    scheduler();
  }
}

function scheduler() {
  if (!playing || !ctx || !graph) return;
  const now = ctx.currentTime;
  const nowPerf = performance.now();
  if (scheduledUntil < now - 0.02) {
    graph.pumpGain.gain.setValueAtTime(Math.max(0, graph.pumpGain.gain.value), now);
    scheduledUntil = now;
  }
  const horizon = now + 0.18;
  const cycle = divisionSeconds(state.bpm, state.pump.rate);
  while (scheduledUntil < horizon) {
    const scene = liveScene(scheduledUntil, now, nowPerf);
    const phase = (fileTimeAt(scheduledUntil) / cycle + state.pump.offset) % 1;
    const depth = state.pump.enabled ? Math.min(1, state.pump.depth * scene.depthMul) : 0;
    const gain = pumpGainAt(phase < 0 ? phase + 1 : phase, depth, state.pump.shape) * scene.gain;
    graph.pumpGain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1.25, gain)), scheduledUntil);
    scheduledUntil += 0.005;
  }
  const sceneNow = liveScene(now, now, nowPerf);
  applyFilter(now, sceneNow);
  graph.riserGain.gain.setTargetAtTime(Math.max(0, sceneNow.riser) * 0.28, now, 0.02);
  graph.riserFilter.frequency.setTargetAtTime(clampCutoff(sceneNow.riserFreq, ctx.sampleRate), now, 0.03);
  schedulerTimer = window.setTimeout(scheduler, 40);
}

function updateTransport() {
  $("play").textContent = playing ? "Pause" : "Play";
  $("play").setAttribute("aria-pressed", playing ? "true" : "false");
}

async function play() {
  if (!state.clip) return;
  try {
    ensureGraph();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  if (ctx.state === "suspended") await ctx.resume();
  if (playing) return;
  if (!playbackBuffer || playbackBuffer.sampleRate !== state.clip.sampleRate) {
    playbackBuffer = toAudioBuffer(ctx, state.clip);
  }
  const source = ctx.createBufferSource();
  source.buffer = playbackBuffer;
  source.loop = state.loop;
  source.connect(graph.filterNode);
  const dur = playbackBuffer.duration;
  const offset = ((playOffset % dur) + dur) % dur;
  playOffset = offset;
  playStartCtx = ctx.currentTime;
  sourceNode = source;
  source.start(playStartCtx, offset);
  source.onended = () => {
    if (sourceNode !== source) return;
    if (!state.loop) {
      playing = false;
      playOffset = 0;
      updateTransport();
    }
  };
  playing = true;
  updateTransport();
  reschedule();
  clearTimeout(schedulerTimer);
  scheduler();
  kickVisuals();
}

function pause() {
  if (!playing) return;
  playOffset = fileTimeAt(ctx.currentTime);
  playing = false;
  const source = sourceNode;
  sourceNode = null;
  try { source?.stop(); } catch { /* already stopped */ }
  clearTimeout(schedulerTimer);
  schedulerTimer = 0;
  updateTransport();
  draw();
}

function stop() {
  pause();
  playOffset = 0;
  if (graph && ctx) {
    const now = ctx.currentTime;
    graph.pumpGain.gain.cancelScheduledValues(now);
    graph.pumpGain.gain.setValueAtTime(1, now);
    graph.riserGain.gain.setTargetAtTime(0, now, 0.02);
  }
  draw();
}

function togglePlay() {
  if (playing) pause();
  else play();
}

function beginHold(type) {
  const count = (holdCounts.get(type) || 0) + 1;
  holdCounts.set(type, count);
  if (count > 1) return;
  if (hold && hold.type !== type) endHold(hold.type, true);
  hold = { type, t0: performance.now() };
  release = null;
  if (playing && ctx && state.clip) {
    record = { type, start: fileTimeAt(ctx.currentTime), sweepSeconds: sweepSeconds() };
  } else {
    record = null;
  }
  $(type === "drop" ? "drop-btn" : type).setAttribute("aria-pressed", "true");
  reschedule();
  kickVisuals();
}

function endHold(type, forced = false) {
  const count = holdCounts.get(type) || 0;
  if (!forced && count > 1) {
    holdCounts.set(type, count - 1);
    return;
  }
  holdCounts.set(type, 0);
  if (!hold || hold.type !== type) return;
  const nowPerf = performance.now();
  const nowCtx = ctx ? ctx.currentTime : 0;
  const from = gestureTargets(
    {
      type,
      heldFor: (nowPerf - hold.t0) / 1000,
      sweepSeconds: sweepSeconds(),
      baseCutoff: state.filter.cutoff,
      baseResonance: state.filter.resonance,
    },
    releaseFrom,
  );
  release = {
    from: { ...from },
    t0: nowPerf,
    dur: type === "cut" ? 0.012 : 0.08,
  };
  if (record && playing && ctx) {
    const end = fileTimeAt(ctx.currentTime);
    commitGesture({ ...record, end });
    record = null;
  }
  hold = null;
  $(type === "drop" ? "drop-btn" : type).setAttribute("aria-pressed", "false");
  reschedule();
  kickVisuals();
}

function commitGesture(event) {
  const dur = duration();
  if (event.end > event.start + 0.04) {
    state.performance.push(event);
  } else if (event.start > 0.05 && event.end < event.start) {
    state.performance.push({ ...event, end: dur });
    if (event.end > 0.04) state.performance.push({ ...event, start: 0 });
  }
  renderGestures();
  markDirty();
}

function renderGestures() {
  const list = $("gestures");
  list.replaceChildren();
  if (!state.performance.length) {
    const item = document.createElement("li");
    item.textContent = "No printed gestures. Hold Build, Drop or Cut while playing.";
    list.appendChild(item);
    return;
  }
  for (const event of state.performance) {
    const item = document.createElement("li");
    const label = event.type[0].toUpperCase() + event.type.slice(1);
    item.textContent = `${label}  ${event.start.toFixed(2)}s – ${event.end.toFixed(2)}s`;
    list.appendChild(item);
  }
}

function buildPeaks(clip) {
  const channel = clip.getChannelData(0);
  const buckets = 1000;
  const next = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(channel.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * size;
    const end = Math.min(channel.length, start + size);
    for (let j = start; j < end; j += 2) peak = Math.max(peak, Math.abs(channel[j]));
    next[i] = peak;
  }
  return next;
}

function draw() {
  const svg = $("wave");
  const w = 1000;
  const h = 168;
  const dur = duration();
  const parts = [];
  if (state.clip && peaks && dur) {
    for (const event of state.performance) {
      const x = (event.start / dur) * w;
      const width = Math.max(1.5, ((event.end - event.start) / dur) * w);
      const fill = event.type === "cut" ? "rgba(196,85,58,0.28)" : event.type === "drop" ? "rgba(217,208,193,0.16)" : "rgba(224,160,69,0.2)";
      parts.push(`<rect x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="${h}" fill="${fill}"></rect>`);
    }
    let bars = "";
    const mid = h * 0.62;
    for (let x = 0; x < w; x += 2) {
      const peak = peaks[Math.floor((x / w) * peaks.length)] || 0;
      const amp = Math.max(0.6, peak * h * 0.4);
      bars += `M${x} ${(mid - amp).toFixed(1)}L${x} ${(mid + amp).toFixed(1)}`;
    }
    parts.push(`<path d="${bars}" stroke="#efe6d6" stroke-width="1.4" fill="none" opacity="0.88" vector-effect="non-scaling-stroke"></path>`);
    let env = "";
    const cycle = divisionSeconds(state.bpm, state.pump.rate);
    for (let x = 0; x <= w; x += 4) {
      const time = (x / w) * dur;
      const phase = (((time / cycle + state.pump.offset) % 1) + 1) % 1;
      const gain = state.pump.enabled ? pumpGainAt(phase, state.pump.depth, state.pump.shape) : 1;
      const y = 10 + (1 - gain) * (h * 0.26);
      env += `${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`;
    }
    parts.push(`<path d="${env}" stroke="#e0a045" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"></path>`);
    const pixelWidth = svg.getBoundingClientRect().width || w;
    const head = (fileTimeAt(ctx ? ctx.currentTime : 0) / dur) * w;
    const headW = Math.max(1.5, (2 / pixelWidth) * w);
    parts.push(`<rect x="${head.toFixed(1)}" y="0" width="${headW.toFixed(2)}" height="${h}" fill="#e0a045"></rect>`);
  }
  svg.innerHTML = parts.join("");
  $("clock").textContent = formatClock(playing || playOffset ? fileTimeAt(ctx ? ctx.currentTime : 0) : playOffset);
}

function drawEnvelope() {
  const path = $("envelope-path");
  let d = "";
  for (let i = 0; i <= 48; i++) {
    const gain = pumpGainAt(i / 48, state.pump.depth, state.pump.shape);
    const x = (i / 48) * 160;
    const y = 6 + (1 - gain) * 40;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  path.setAttribute("d", d);
}

function cutoffToX(hz) {
  return Math.log(Math.max(40, hz) / 40) / Math.log(18000 / 40);
}

function positionThumb(cutoff = state.filter.cutoff, resonance = state.filter.resonance) {
  const thumb = $("thumb");
  thumb.style.left = `${clamp01(cutoffToX(cutoff)) * 100}%`;
  thumb.style.top = `${(1 - clamp01(resonance)) * 100}%`;
}

function reflectNumbers() {
  $("depth").value = String(Math.round(state.pump.depth * 100));
  $("depth-out").textContent = `${Math.round(state.pump.depth * 100)}%`;
  $("shape").value = String(Math.round(state.pump.shape * 100));
  $("shape-out").textContent = shapeWord(state.pump.shape);
  $("offset").value = String(Math.round(state.pump.offset * 100));
  $("offset-out").textContent = `${Math.round(state.pump.offset * 100)}%`;
  $("output").value = String(Math.round(state.output * 100));
  $("output-out").textContent = `${Math.round(state.output * 100)}%`;
  $("bpm").value = String(state.bpm);
  $("bpm-out").textContent = state.bpm.toFixed(1);
  $("bpm-value").textContent = state.bpm.toFixed(1);
  $("pump-on").checked = state.pump.enabled;
  $("filter-on").checked = state.filter.enabled;
  $("loop").checked = state.loop;
  showCutoff(displayCutoff());
  $("q-value").textContent = displayResonance().toFixed(2);
  for (const button of $("rates").querySelectorAll("button")) {
    const on = button.dataset.rate === state.pump.rate;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  for (const button of $("types").querySelectorAll("button")) {
    const on = button.dataset.type === state.filter.type;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  for (const button of $("bars").querySelectorAll("button")) {
    const on = Number(button.dataset.bars) === state.sweepBars;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  drawEnvelope();
  positionThumb(displayCutoff(), displayResonance());
  $("clip-name").textContent = state.clipName || "Audio";
  const dur = duration();
  $("clip-time").textContent = dur ? `${formatClock(dur)} · ${state.clip.sampleRate} Hz` : "Drop a loop";
}

function displayCutoff() {
  if (!hold && !release) return state.filter.cutoff;
  if (hold) {
    return gestureTargets({
      type: hold.type,
      heldFor: (performance.now() - hold.t0) / 1000,
      sweepSeconds: sweepSeconds(),
      baseCutoff: state.filter.cutoff,
      baseResonance: state.filter.resonance,
    }).cutoff;
  }
  const u = Math.min(1, (performance.now() - release.t0) / 1000 / release.dur);
  return expLerp(release.from.cutoff, state.filter.cutoff, u);
}

function displayResonance() {
  if (hold) {
    return gestureTargets({
      type: hold.type,
      heldFor: (performance.now() - hold.t0) / 1000,
      sweepSeconds: sweepSeconds(),
      baseCutoff: state.filter.cutoff,
      baseResonance: state.filter.resonance,
    }).resonance;
  }
  if (release) {
    const u = Math.min(1, (performance.now() - release.t0) / 1000 / release.dur);
    return release.from.resonance + (state.filter.resonance - release.from.resonance) * u;
  }
  return state.filter.resonance;
}

function paintHeadsUp() {
  const cutoff = displayCutoff();
  const resonance = displayResonance();
  showCutoff(cutoff);
  $("q-value").textContent = resonance.toFixed(2);
  positionThumb(cutoff, resonance);
  draw();
}

function markDirty() {
  if (!applying) $("preset").value = "";
}

function setClip(clip, name, bpm) {
  state.clip = clip;
  state.clipName = name;
  peaks = buildPeaks(clip);
  playbackBuffer = null;
  playOffset = 0;
  if (playing) {
    pause();
    playOffset = 0;
  }
  if (bpm) state.bpm = clampBpm(bpm);
  reflectNumbers();
  renderGestures();
  draw();
}

function loadDemo() {
  const demo = renderDemoLoop({ bpm: 124, bars: 4 });
  state.demo = true;
  state.performance = [];
  setClip(demo.buffer, "Desk loop", demo.bpm);
  setStatus("Desk loop is on the deck. Drop a track anywhere to replace it.");
}

async function loadFile(file) {
  setStatus("Decoding…");
  try {
    ensureGraph();
    if (ctx.state === "suspended") await ctx.resume();
    const decoded = await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));
    const channels = [];
    for (let i = 0; i < decoded.numberOfChannels; i++) {
      channels.push(Float32Array.from(decoded.getChannelData(i)));
    }
    const clip = {
      sampleRate: decoded.sampleRate,
      numberOfChannels: decoded.numberOfChannels,
      length: decoded.length,
      channels,
      getChannelData: (index) => channels[index],
    };
    state.demo = false;
    state.performance = [];
    setClip(clip, file.name.replace(/\.[^.]+$/, ""), null);
    playbackBuffer = decoded;
    const guess = detectBpm(clip);
    state.bpm = guess.bpm;
    reflectNumbers();
    reschedule();
    const trust = guess.confidence >= 0.12;
    setStatus(trust ? `Tempo guess ${guess.bpm} BPM. Nudge Align so the duck sits on the kick.` : "Could not hear a steady tempo. Tap it in.");
  } catch (error) {
    setStatus(error && error.message ? error.message : "Could not decode that file");
  }
}

function applyPreset(preset, filename) {
  applying = true;
  if (preset.pump) state.pump = { ...state.pump, ...preset.pump };
  if (preset.filter) state.filter = { ...state.filter, ...preset.filter };
  if (preset.sweepBars) state.sweepBars = Number(preset.sweepBars) || state.sweepBars;
  if (preset.output != null) state.output = Math.min(1.5, Math.max(0, Number(preset.output)));
  if (state.demo && preset.bpm) {
    if (playing) pause();
    const nextBpm = clampBpm(preset.bpm);
    const demo = renderDemoLoop({ bpm: nextBpm, bars: 4 });
    state.clip = demo.buffer;
    state.bpm = demo.bpm;
    peaks = buildPeaks(demo.buffer);
    playbackBuffer = null;
    playOffset = 0;
  } else if (!state.demo && preset.bpm) {
    setStatus(`${preset.name} loaded. Kept your tempo at ${state.bpm.toFixed(1)} BPM.`);
  }
  state.performance = (preset.performance || []).map((event) => ({ ...event }));
  if (state.demo || !preset.bpm) setStatus(`${preset.name || "Preset"} loaded.`);
  if (filename) $("preset").value = filename;
  reflectNumbers();
  renderGestures();
  reschedule();
  draw();
  applying = false;
}

function collectPreset() {
  return {
    name: state.clipName || "Pump Sweep",
    bpm: state.bpm,
    sweepBars: state.sweepBars,
    output: state.output,
    pump: { ...state.pump },
    filter: { ...state.filter },
    performance: state.performance.map((event) => ({ ...event })),
  };
}

function seek(fraction) {
  const dur = duration();
  if (!dur) return;
  const was = playing;
  if (was) pause();
  playOffset = clamp01(fraction) * dur;
  if (was) play();
  else draw();
}

function padFromClient(clientX, clientY) {
  const rect = $("pad").getBoundingClientRect();
  const x = clamp01((clientX - rect.left) / rect.width);
  const y = clamp01(1 - (clientY - rect.top) / rect.height);
  state.filter.cutoff = expLerp(40, 18000, x);
  state.filter.resonance = y;
  markDirty();
  reflectNumbers();
  reschedule();
}

function frame() {
  if (playing || hold || release) {
    if (graph) {
      const data = new Uint8Array(graph.analyser.fftSize);
      graph.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
      $("meter").style.transform = `scaleX(${Math.min(1, peak * 1.4)})`;
    }
    paintHeadsUp();
    visual = requestAnimationFrame(frame);
  } else {
    visual = 0;
    $("meter").style.transform = "scaleX(0)";
  }
}

function kickVisuals() {
  if (!visual) visual = requestAnimationFrame(frame);
}

function wireHold(id, type) {
  const button = $(id);
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    beginHold(type);
  });
  const finish = () => endHold(type);
  button.addEventListener("pointerup", finish);
  button.addEventListener("pointercancel", finish);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

function makeSeg(container, items, onPick) {
  for (const [value, label] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.textContent = label;
    button.dataset[container.dataset.key] = value;
    button.addEventListener("click", () => onPick(value));
    container.appendChild(button);
  }
}

function bootControls() {
  $("rates").dataset.key = "rate";
  $("types").dataset.key = "type";
  $("bars").dataset.key = "bars";
  makeSeg($("rates"), RATES.map((rate) => [rate, rate]), (rate) => {
    state.pump.rate = rate;
    markDirty();
    reflectNumbers();
    reschedule();
    draw();
  });
  makeSeg($("types"), TYPES, (type) => {
    state.filter.type = type;
    markDirty();
    reflectNumbers();
    reschedule();
  });
  makeSeg($("bars"), [["1", "1 bar"], ["2", "2"], ["4", "4"], ["8", "8"]], (bars) => {
    state.sweepBars = Number(bars);
    markDirty();
    reflectNumbers();
  });

  const bindRange = (id, output, read) => {
    $(id).addEventListener("input", () => {
      read(Number($(id).value));
      markDirty();
      reflectNumbers();
      reschedule();
      draw();
    });
    if (output) $(output).textContent = "";
  };
  bindRange("depth", "depth-out", (value) => { state.pump.depth = value / 100; });
  bindRange("shape", "shape-out", (value) => { state.pump.shape = value / 100; });
  bindRange("offset", "offset-out", (value) => { state.pump.offset = value / 100; });
  bindRange("output", "output-out", (value) => { state.output = value / 100; });
  bindRange("bpm", "bpm-out", (value) => { state.bpm = clampBpm(value); });

  $("pump-on").addEventListener("change", () => {
    state.pump.enabled = $("pump-on").checked;
    markDirty();
    reschedule();
    draw();
  });
  $("filter-on").addEventListener("change", () => {
    state.filter.enabled = $("filter-on").checked;
    markDirty();
    reschedule();
  });
  $("loop").addEventListener("change", () => {
    state.loop = $("loop").checked;
    if (sourceNode) sourceNode.loop = state.loop;
  });
  $("play").addEventListener("click", togglePlay);
  $("stop").addEventListener("click", stop);
  $("demo").addEventListener("click", () => {
    stop();
    loadDemo();
  });
  $("detect").addEventListener("click", () => {
    if (!state.clip) return;
    const guess = detectBpm(state.clip);
    state.bpm = guess.bpm;
    reflectNumbers();
    reschedule();
    draw();
    setStatus(guess.confidence >= 0.12 ? `Detected ${guess.bpm} BPM.` : "Detection was unsure. Tap a steadier stretch.");
  });
  $("tap").addEventListener("click", tapTempo);
  $("clear-gestures").addEventListener("click", () => {
    state.performance = [];
    renderGestures();
    markDirty();
    draw();
  });
  $("export").addEventListener("click", async () => {
    if (!state.clip) return;
    setStatus("Rendering bounce…");
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const rendered = processPumpSweep(state.clip, paramsFromState());
      const safe = (state.clipName || "pump-sweep").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      downloadWavChannels(rendered.channels, rendered.sampleRate, `${safe || "pump-sweep"}.wav`);
      setStatus("WAV downloaded.");
    } catch (error) {
      setStatus(error.message || "Export failed");
    }
  });
  $("save-preset").addEventListener("click", () => {
    const preset = collectPreset();
    const json = serializeLoosePreset(preset);
    triggerDownload(new TextEncoder().encode(json), presetFilename(preset.name), "application/json");
    setStatus("Preset JSON downloaded.");
  });
  $("load-preset").addEventListener("click", () => $("preset-file").click());
  $("preset-file").addEventListener("change", async () => {
    const file = $("preset-file").files?.[0];
    $("preset-file").value = "";
    if (!file) return;
    try {
      applyPreset(parseLoosePreset(await file.text()));
    } catch (error) {
      setStatus(error.message);
    }
  });
  $("load-btn").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", () => {
    const file = $("file").files?.[0];
    $("file").value = "";
    if (file) loadFile(file);
  });

  const deck = $("deck");
  const allow = (event) => {
    event.preventDefault();
    deck.classList.add("dragover");
  };
  deck.addEventListener("dragenter", allow);
  deck.addEventListener("dragover", allow);
  deck.addEventListener("dragleave", () => deck.classList.remove("dragover"));
  deck.addEventListener("drop", (event) => {
    event.preventDefault();
    deck.classList.remove("dragover");
    const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("audio") || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(item.name));
    if (file) loadFile(file);
    else setStatus("Drop an audio file.");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  $("wave").addEventListener("pointerdown", (event) => {
    const rect = $("wave").getBoundingClientRect();
    seek((event.clientX - rect.left) / rect.width);
  });

  const pad = $("pad");
  pad.addEventListener("pointerdown", (event) => {
    pad.setPointerCapture(event.pointerId);
    padFromClient(event.clientX, event.clientY);
  });
  pad.addEventListener("pointermove", (event) => {
    if (pad.hasPointerCapture(event.pointerId)) padFromClient(event.clientX, event.clientY);
  });
  pad.addEventListener("keydown", (event) => {
    const stepX = event.shiftKey ? 0.01 : 0.03;
    const stepY = event.shiftKey ? 0.02 : 0.05;
    let x = cutoffToX(state.filter.cutoff);
    let y = state.filter.resonance;
    if (event.key === "ArrowLeft") x -= stepX;
    else if (event.key === "ArrowRight") x += stepX;
    else if (event.key === "ArrowDown") y -= stepY;
    else if (event.key === "ArrowUp") y += stepY;
    else return;
    event.preventDefault();
    state.filter.cutoff = expLerp(40, 18000, clamp01(x));
    state.filter.resonance = clamp01(y);
    markDirty();
    reflectNumbers();
    reschedule();
  });

  wireHold("build", "build");
  wireHold("drop-btn", "drop");
  wireHold("cut", "cut");

  $("midi").addEventListener("click", async () => {
    const stop = await bindMidiPerformance({
      onNote({ note }) {
        if (note === 48) beginHold("build");
        else if (note === 50) beginHold("drop");
        else if (note === 52) beginHold("cut");
      },
      onNoteOff({ note }) {
        if (note === 48) endHold("build");
        else if (note === 50) endHold("drop");
        else if (note === 52) endHold("cut");
      },
      onCC({ controller, value }) {
        if (controller === 1 || controller === 74) setCutoffFromMidi(value);
        else if (controller === 71) {
          state.filter.resonance = clamp01(value);
          markDirty();
          reflectNumbers();
          reschedule();
        }
      },
      onStatus(info) {
        setStatus(info?.message || "MIDI");
      },
    });
    midiStops.push(stop);
  });

  window.addEventListener("resize", draw);
}

function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] < 180) return;
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length >= 2) {
    const recent = taps.slice(-6);
    let total = 0;
    for (let i = 1; i < recent.length; i++) total += recent[i] - recent[i - 1];
    state.bpm = Math.round(clampBpm(60000 / (total / (recent.length - 1))) * 10) / 10;
    reflectNumbers();
    reschedule();
    draw();
    setStatus(`Tap tempo ${state.bpm.toFixed(1)} BPM.`);
  } else {
    setStatus("Tap again.");
  }
}

function setCutoffFromMidi(normalized) {
  state.filter.cutoff = expLerp(40, 18000, clamp01(normalized));
  markDirty();
  reflectNumbers();
  reschedule();
}

bindKeyHolds({
  Space: { down: () => togglePlay() },
  KeyT: { down: () => tapTempo() },
  KeyZ: { down: () => beginHold("build"), up: () => endHold("build") },
  KeyX: { down: () => beginHold("drop"), up: () => endHold("drop") },
  KeyC: { down: () => beginHold("cut"), up: () => endHold("cut") },
});

const midiStops = [];

async function loadFactory() {
  const select = $("preset");
  const manual = document.createElement("option");
  manual.value = "";
  manual.textContent = "Manual";
  select.appendChild(manual);
  try {
    const index = await fetch("./presets/index.json").then((response) => response.json());
    for (const file of index) {
      const preset = await fetch(`./presets/${file}`).then((response) => response.json());
      presets.set(file, preset);
      const option = document.createElement("option");
      option.value = file;
      option.textContent = preset.name || file;
      select.appendChild(option);
    }
  } catch {
    setStatus("Factory presets did not load.");
  }
  select.addEventListener("change", () => {
    const preset = presets.get(select.value);
    if (preset) applyPreset(preset, select.value);
  });
}

bootControls();
loadDemo();
loadFactory();
renderGestures();
setStatus("Desk loop is on the deck. Press play, then hold Build.");
