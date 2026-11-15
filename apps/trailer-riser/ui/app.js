/* Atelier Instruments — MIT License. Panel for the trailer riser and impact maker. */

import {
  KINDS,
  DEFAULT_PARAMS,
  normalizeParams,
  render,
  gestureSeconds,
  tailSeconds,
  variationParams,
} from '../engine.js';
import { downloadWavChannels, triggerDownload } from '../../../shared/wav-export.js';
import { noteName } from '../../../shared/midi.js';
import { bindKeys, bindMidiPerformance } from '../../../shared/keys-and-midi-input.js';

const FACTORY = [
  'cold-open.json',
  'eight-bar-climb.json',
  'tunnel-pass.json',
  'low-brass.json',
  'abyss-drop.json',
  'reverse-into-picture.json',
  'hard-cut.json',
  'far-thunder.json',
];

const FADERS = [
  { id: 'seconds', label: 'Length', min: 0.2, max: 16, step: 0.01, show: (p) => p.lengthMode === 'seconds', format: (v) => `${Number(v).toFixed(2)} s` },
  { id: 'bars', label: 'Bars', min: 1, max: 16, step: 1, show: (p) => p.lengthMode === 'bars', format: (v) => `${Math.round(v)}` },
  { id: 'tempo', label: 'Tempo', min: 40, max: 220, step: 1, show: (p) => p.lengthMode === 'bars', format: (v) => `${Math.round(v)} bpm` },
  { id: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, show: () => true, format: (v) => Number(v).toFixed(2) },
  { id: 'pitch', label: 'Pitch', min: 16, max: 84, step: 1, show: () => true, format: (v) => noteName(v) },
  { id: 'darkness', label: 'Darkness', min: 0, max: 1, step: 0.01, show: () => true, format: (v) => Number(v).toFixed(2) },
  { id: 'size', label: 'Size', min: 0, max: 1, step: 0.01, show: () => true, format: (v) => Number(v).toFixed(2) },
];

const state = {
  params: { ...DEFAULT_PARAMS },
  factory: [],
  ctx: null,
  source: null,
  token: 0,
  playing: false,
  batching: false,
  timer: 0,
  columns: null,
  columnWidth: 0,
  audio: null,
  startedAt: 0,
  raf: 0,
  bend: 0,
  midi: null,
};

const els = {
  kinds: document.getElementById('kinds'),
  faders: document.getElementById('faders'),
  scope: document.getElementById('scope'),
  hint: document.getElementById('hint'),
  status: document.getElementById('status'),
  time: document.getElementById('time-readout'),
  peak: document.getElementById('peak-readout'),
  play: document.getElementById('play'),
  stop: document.getElementById('stop'),
  exportBtn: document.getElementById('export'),
  batch: document.getElementById('batch'),
  presetSelect: document.getElementById('preset-select'),
  presetName: document.getElementById('preset-name'),
  save: document.getElementById('save-preset'),
  load: document.getElementById('load-preset'),
  file: document.getElementById('preset-file'),
  midi: document.getElementById('midi-arm'),
  drawer: document.getElementById('batch-drawer'),
  batchList: document.getElementById('batch-list'),
  downloadAll: document.getElementById('download-all'),
  seed: document.getElementById('seed'),
  modeSeconds: document.getElementById('mode-seconds'),
  modeBars: document.getElementById('mode-bars'),
  app: document.querySelector('.rise'),
};

const faderInputs = new Map();
let silent = false;

function setStatus(text) {
  els.status.textContent = text;
}

function kindMeta(id) {
  return KINDS.find((kind) => kind.id === id) || KINDS[0];
}

function currentParams() {
  return normalizeParams(state.params);
}

function markCustom() {
  if (els.presetSelect.value !== 'custom') {
    const option = els.presetSelect.querySelector('option[value="custom"]');
    if (!option) {
      const created = document.createElement('option');
      created.value = 'custom';
      created.textContent = 'Custom';
      els.presetSelect.appendChild(created);
    }
    els.presetSelect.value = 'custom';
  }
}

function buildPads() {
  KINDS.forEach((kind, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pad kind-pad';
    button.dataset.kind = kind.id;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `<span class="led" aria-hidden="true"></span><span class="pad-name"></span><span class="pad-key"></span>`;
    button.querySelector('.pad-name').textContent = kind.name;
    button.querySelector('.pad-key').textContent = String(index + 1);
    button.addEventListener('click', () => {
      state.params.kind = kind.id;
      markCustom();
      syncPads();
      updateCopy();
      scheduleRender();
    });
    els.kinds.appendChild(button);
  });
}

function syncPads() {
  const current = state.params.kind;
  for (const button of els.kinds.querySelectorAll('.pad')) {
    const on = button.dataset.kind === current;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  els.hint.textContent = kindMeta(current).blurb;
}

function buildFaders() {
  for (const spec of FADERS) {
    const wrap = document.createElement('label');
    wrap.className = 'slider fader';
    wrap.dataset.fader = spec.id;
    wrap.innerHTML = `<span class="fader-top"><span class="slider-name"></span><b class="fader-value"></b></span>`;
    wrap.querySelector('.slider-name').textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.setAttribute('aria-label', spec.label);
    input.addEventListener('input', () => {
      if (silent) return;
      state.params[spec.id] = Number(input.value);
      markCustom();
      wrap.querySelector('.fader-value').textContent = spec.format(input.value);
      updateCopy();
      scheduleRender();
    });
    wrap.appendChild(input);
    els.faders.appendChild(wrap);
    faderInputs.set(spec.id, { spec, wrap, input, readout: wrap.querySelector('.fader-value') });
  }
}

function syncControls() {
  silent = true;
  const params = state.params;
  for (const { spec, wrap, input, readout } of faderInputs.values()) {
    input.value = String(params[spec.id]);
    readout.textContent = spec.format(params[spec.id]);
    wrap.hidden = !spec.show(params);
  }
  els.seed.value = String(params.seed);
  const bars = params.lengthMode === 'bars';
  els.modeSeconds.setAttribute('aria-pressed', bars ? 'false' : 'true');
  els.modeBars.setAttribute('aria-pressed', bars ? 'true' : 'false');
  silent = false;
  syncPads();
  updateCopy();
}

function updateCopy() {
  const params = currentParams();
  state.params = params;
  const gesture = gestureSeconds(params);
  const total = gesture + tailSeconds(params);
  if (params.lengthMode === 'bars') {
    els.time.textContent = `${params.bars} bars · ${Math.round(params.tempo)} bpm · ${gesture.toFixed(2)}s`;
  } else {
    els.time.textContent = `${gesture.toFixed(2)}s gesture · ${total.toFixed(2)}s file`;
  }
}

function applyPreset(data, name) {
  state.params = normalizeParams(data);
  if (name) els.presetName.value = name;
  syncControls();
  scheduleRender();
}

function scheduleRender() {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => {
    try {
      const audio = render(currentParams(), { sampleRate: 48000 });
      state.audio = audio;
      state.columns = null;
      const db = audio.peak < 1e-5 ? '-inf' : `${(20 * Math.log10(audio.peak)).toFixed(1)} dB`;
      els.peak.textContent = db;
      drawScope(state.playing ? playhead() : -1);
      if (!state.playing && !state.batching) setStatus('Ready');
    } catch (error) {
      setStatus(error.message || 'Render failed');
    }
  }, 60);
}

function bakeColumns(left, width) {
  const cols = new Array(width);
  const step = left.length / width;
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * step);
    const end = Math.max(start + 1, Math.floor((x + 1) * step));
    let min = 1;
    let max = -1;
    for (let i = start; i < end && i < left.length; i += 1) {
      const value = left[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    cols[x] = { min, max };
  }
  return cols;
}

function drawScope(playheadRatio) {
  const canvas = els.scope;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  const pxW = Math.floor(width * dpr);
  const pxH = Math.floor(height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
    state.columns = null;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070706';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255, 176, 58, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  for (let x = 40; x < width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  const audio = state.audio;
  if (!audio) return;
  if (!state.columns || state.columnWidth !== width) {
    state.columns = bakeColumns(audio.left, Math.floor(width));
    state.columnWidth = width;
  }
  const mid = height / 2;
  const amp = mid - 6;
  ctx.fillStyle = '#ffb03a';
  const cols = state.columns;
  for (let x = 0; x < cols.length; x += 1) {
    const y1 = mid - cols[x].max * amp;
    const y2 = mid - cols[x].min * amp;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  if (audio.frames > 0) {
    const cut = (audio.gestureFrames / audio.frames) * width;
    ctx.fillStyle = 'rgba(255, 236, 210, 0.35)';
    ctx.fillRect(cut, 0, 1, height);
  }
  if (playheadRatio >= 0 && playheadRatio <= 1) {
    ctx.fillStyle = '#fff4df';
    ctx.fillRect(playheadRatio * width, 0, 1.5, height);
  }
}

function playhead() {
  if (!state.playing || !state.ctx || !state.audio) return -1;
  const elapsed = state.ctx.currentTime - state.startedAt;
  return elapsed / state.audio.duration;
}

function loopPlayhead() {
  if (!state.playing) return;
  drawScope(playhead());
  state.raf = requestAnimationFrame(loopPlayhead);
}

async function ensureContext() {
  if (!state.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
  }
  if (state.ctx.state === 'suspended') {
    await Promise.race([
      state.ctx.resume(),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ]);
  }
  return state.ctx;
}

function stopPlayback() {
  state.token += 1;
  if (state.source) {
    try { state.source.onended = null; state.source.stop(); } catch { /* already stopped */ }
    try { state.source.disconnect(); } catch { /* already disconnected */ }
    state.source = null;
  }
  state.playing = false;
  els.app.classList.remove('is-live');
  if (state.raf) cancelAnimationFrame(state.raf);
  drawScope(-1);
}

async function play(overrides) {
  const params = normalizeParams({ ...currentParams(), ...overrides });
  setStatus('Rendering');
  await new Promise((resolve) => setTimeout(resolve, 16));
  let audio;
  try {
    audio = render(params, { sampleRate: 48000 });
  } catch (error) {
    setStatus(error.message || 'Render failed');
    return;
  }
  state.audio = audio;
  state.columns = null;
  const ctx = await ensureContext();
  stopPlayback();
  const buffer = ctx.createBuffer(2, audio.frames, audio.sampleRate);
  buffer.getChannelData(0).set(audio.left);
  buffer.getChannelData(1).set(audio.right);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const token = state.token + 1;
  state.token = token;
  source.onended = () => {
    if (state.token !== token) return;
    state.playing = false;
    state.source = null;
    els.app.classList.remove('is-live');
    setStatus('Ready');
    drawScope(-1);
  };
  state.source = source;
  state.playing = true;
  state.startedAt = ctx.currentTime;
  els.app.classList.add('is-live');
  source.start();
  setStatus(`Playing ${kindMeta(params.kind).name}`);
  loopPlayhead();
}

function fileSlug(params) {
  const note = noteName(params.pitch).replace('#', 's');
  const dur = params.lengthMode === 'bars'
    ? `${params.bars}bar-${Math.round(params.tempo)}bpm`
    : `${params.seconds.toFixed(2)}s`;
  return `${params.kind}-${note}-${dur}-s${params.seed}`;
}

function exportCurrent() {
  const params = currentParams();
  const audio = state.audio && samePatch(state.audio.params, params)
    ? state.audio
    : render(params, { sampleRate: 48000 });
  state.audio = audio;
  downloadWavChannels([audio.left, audio.right], audio.sampleRate, `${fileSlug(params)}.wav`);
  setStatus('WAV saved');
}

function samePatch(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind
    && a.lengthMode === b.lengthMode
    && a.seconds === b.seconds
    && a.bars === b.bars
    && a.tempo === b.tempo
    && a.intensity === b.intensity
    && a.pitch === b.pitch
    && a.darkness === b.darkness
    && a.size === b.size
    && a.seed === b.seed;
}

async function runBatch() {
  if (state.batching) return;
  state.batching = true;
  els.batch.disabled = true;
  els.drawer.hidden = false;
  els.batchList.replaceChildren();
  const base = currentParams();
  const ready = [];
  for (let i = 0; i < 8; i += 1) {
    setStatus(`Rendering variation ${i + 1} of 8`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const params = variationParams(base, i);
    const audio = render(params, { sampleRate: 48000 });
    const slug = fileSlug(params);
    ready.push({ audio, slug, params });
    const item = document.createElement('li');
    item.className = 'var-row';
    const index = document.createElement('span');
    index.className = 'readout';
    index.textContent = String(i + 1).padStart(2, '0');
    const copy = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'var-title';
    title.textContent = `${kindMeta(params.kind).name} · ${noteName(params.pitch)}`;
    const meta = document.createElement('p');
    meta.className = 'var-meta';
    meta.textContent = `dark ${params.darkness.toFixed(2)} · size ${params.size.toFixed(2)} · seed ${params.seed}`;
    copy.append(title, meta);
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'key tiny';
    playBtn.textContent = 'Play';
    playBtn.addEventListener('click', async () => {
      state.audio = audio;
      state.columns = null;
      const ctx = await ensureContext();
      stopPlayback();
      const buffer = ctx.createBuffer(2, audio.frames, audio.sampleRate);
      buffer.getChannelData(0).set(audio.left);
      buffer.getChannelData(1).set(audio.right);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const token = state.token + 1;
      state.token = token;
      source.onended = () => {
        if (state.token !== token) return;
        state.playing = false;
        els.app.classList.remove('is-live');
        setStatus('Ready');
      };
      state.source = source;
      state.playing = true;
      state.startedAt = ctx.currentTime;
      els.app.classList.add('is-live');
      source.start();
      setStatus(`Variation ${i + 1}`);
      loopPlayhead();
    });
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'key tiny';
    saveBtn.textContent = 'WAV';
    saveBtn.addEventListener('click', () => {
      downloadWavChannels([audio.left, audio.right], audio.sampleRate, `${slug}.wav`);
    });
    item.append(index, copy, playBtn, saveBtn);
    els.batchList.appendChild(item);
  }
  els.downloadAll.onclick = async () => {
    for (let i = 0; i < ready.length; i += 1) {
      const row = ready[i];
      downloadWavChannels([row.audio.left, row.audio.right], row.audio.sampleRate, `${row.slug}.wav`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    setStatus('Downloading 8 WAVs');
  };
  state.batching = false;
  els.batch.disabled = false;
  setStatus('Eight variations ready');
}

function nudge(key, delta) {
  const spec = FADERS.find((item) => item.id === key);
  const next = Math.min(spec.max, Math.max(spec.min, Number(state.params[key]) + delta));
  state.params[key] = next;
  markCustom();
  syncControls();
  scheduleRender();
}

function setParam(key, value) {
  state.params[key] = value;
  markCustom();
  syncControls();
  scheduleRender();
}

function readPresetText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Preset is not valid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Preset must be a JSON object');
  }
  return data;
}

function onKey(event) {
  const index = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(event.code);
  if (index >= 0) {
    state.params.kind = KINDS[index].id;
    markCustom();
    syncPads();
    updateCopy();
    play();
    return;
  }
  if (event.code === 'Space') {
    if (state.playing) stopPlayback();
    else play();
    return;
  }
  if (event.code === 'KeyE') {
    exportCurrent();
    return;
  }
  if (event.code === 'KeyB') {
    runBatch();
    return;
  }
  if (event.code === 'BracketLeft') nudge('pitch', -1);
  else if (event.code === 'BracketRight') nudge('pitch', 1);
}

async function armMidi() {
  if (state.midi) return;
  state.midi = true;
  await bindMidiPerformance({
    onStatus: (status) => setStatus(status.message),
    onPitchBend: (message) => {
      state.bend = message.bend;
    },
    onCC: (message) => {
      if (message.controller === 1) setParam('intensity', message.value);
      else if (message.controller === 74) setParam('darkness', message.value);
      else if (message.controller === 71) setParam('size', message.value);
    },
    onNote: (message) => {
      const pitch = Math.min(84, Math.max(16, message.note + state.bend * 2));
      state.params.pitch = pitch;
      syncControls();
      const intensity = Math.min(1, state.params.intensity * (0.45 + message.velocity * 0.7));
      play({ pitch, intensity });
    },
  });
}

function presetPayload() {
  return {
    ...currentParams(),
    name: els.presetName.value.trim() || 'Custom',
  };
}

async function loadFactory() {
  const select = els.presetSelect;
  select.replaceChildren();
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Custom';
  select.appendChild(custom);
  const loaded = [];
  for (const file of FACTORY) {
    try {
      const response = await fetch(`./presets/${file}`);
      if (!response.ok) continue;
      const data = readPresetText(await response.text());
      loaded.push({ file, data });
      const option = document.createElement('option');
      option.value = file;
      option.textContent = data.name || file;
      select.appendChild(option);
    } catch {
      /* skip a broken preset file */
    }
  }
  state.factory = loaded;
  if (loaded.length) {
    select.value = loaded[0].file;
    applyPreset(loaded[0].data, loaded[0].data.name);
  } else {
    applyPreset(DEFAULT_PARAMS, 'Custom');
    setStatus('Using built-in settings');
  }
}

els.modeSeconds.addEventListener('click', () => {
  state.params.lengthMode = 'seconds';
  markCustom();
  syncControls();
  scheduleRender();
});
els.modeBars.addEventListener('click', () => {
  state.params.lengthMode = 'bars';
  markCustom();
  syncControls();
  scheduleRender();
});
els.seed.addEventListener('input', () => {
  if (silent) return;
  state.params.seed = Number(els.seed.value);
  markCustom();
  updateCopy();
  scheduleRender();
});
els.play.addEventListener('click', () => play());
els.stop.addEventListener('click', () => {
  stopPlayback();
  setStatus('Stopped');
});
els.exportBtn.addEventListener('click', () => exportCurrent());
els.batch.addEventListener('click', () => runBatch());
els.presetSelect.addEventListener('change', () => {
  const found = state.factory.find((item) => item.file === els.presetSelect.value);
  if (!found) return;
  applyPreset(found.data, found.data.name);
});
els.save.addEventListener('click', () => {
  const payload = presetPayload();
  const slug = (payload.name || 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`);
  triggerDownload(bytes, `${slug}.json`, 'application/json');
  setStatus('Preset saved');
});
els.load.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', async () => {
  const file = els.file.files && els.file.files[0];
  els.file.value = '';
  if (!file) return;
  try {
    const data = readPresetText(await file.text());
    markCustom();
    applyPreset(data, data.name || file.name.replace(/\.json$/i, ''));
    setStatus('Preset loaded');
  } catch (error) {
    setStatus(error.message || 'Could not read preset');
  }
});
els.midi.addEventListener('click', () => armMidi());
bindKeys({
  Digit1: () => onKey({ code: 'Digit1' }),
  Digit2: () => onKey({ code: 'Digit2' }),
  Digit3: () => onKey({ code: 'Digit3' }),
  Digit4: () => onKey({ code: 'Digit4' }),
  Digit5: () => onKey({ code: 'Digit5' }),
  Digit6: () => onKey({ code: 'Digit6' }),
  Space: () => onKey({ code: 'Space' }),
  KeyE: () => onKey({ code: 'KeyE' }),
  KeyB: () => onKey({ code: 'KeyB' }),
  BracketLeft: () => onKey({ code: 'BracketLeft' }),
  BracketRight: () => onKey({ code: 'BracketRight' }),
});
window.addEventListener('resize', () => {
  state.columns = null;
  drawScope(state.playing ? playhead() : -1);
});

buildPads();
buildFaders();
loadFactory();
