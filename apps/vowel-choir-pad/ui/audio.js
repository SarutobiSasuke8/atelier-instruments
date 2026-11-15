import { clamp, midiToHz, singerLayout, timbreAt } from '../engine.js';

function noiseBuffer(ctx) {
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let state = 0x1234567;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    data[i] = (state / 4294967296) * 2 - 1;
  }
  return buffer;
}

function impulse(ctx) {
  const seconds = 2.3;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let state = 0x9e3779b9 + channel * 97;
    for (let i = 0; i < length; i++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const white = (state / 4294967296) * 2 - 1;
      const t = i / length;
      data[i] = white * (1 - t) ** 3.2;
    }
    [0.009, 0.014, 0.021, 0.029, 0.041, 0.057].forEach((tap, index) => {
      const at = Math.floor((tap + channel * 0.0015) * ctx.sampleRate);
      if (at < length) data[at] += (index % 2 ? -0.32 : 0.42) * (1 - index * 0.08);
    });
  }
  return buffer;
}

function sawWave(ctx) {
  const n = 28;
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let harmonic = 1; harmonic <= n; harmonic++) imag[harmonic] = 1 / harmonic;
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

function spawnSinger(ctx, dest, buffer, wave) {
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  const tone = ctx.createGain();
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const noiseHp = ctx.createBiquadFilter();
  noiseHp.type = 'highpass';
  noiseHp.frequency.value = 780;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;

  const amp = ctx.createGain();
  amp.gain.value = 0;
  const panner = ctx.createStereoPanner();
  const filters = [];
  const gains = [];
  osc.connect(tone);
  noise.connect(noiseHp);
  noiseHp.connect(noiseGain);
  for (let i = 0; i < 4; i++) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const gain = ctx.createGain();
    tone.connect(filter);
    noiseGain.connect(filter);
    filter.connect(gain);
    gain.connect(amp);
    filters.push(filter);
    gains.push(gain);
  }
  amp.connect(panner);
  panner.connect(dest);
  osc.start();
  lfo.start();
  noise.start();
  return { osc, lfo, lfoGain, tone, noise, noiseHp, noiseGain, amp, panner, filters, gains };
}

function disconnectSinger(singer) {
  const nodes = [
    singer.osc, singer.lfo, singer.lfoGain, singer.tone, singer.noise,
    singer.noiseHp, singer.noiseGain, singer.amp, singer.panner,
    ...singer.filters, ...singer.gains,
  ];
  for (const node of nodes) {
    try { node.disconnect(); } catch { /* already torn down */ }
  }
}

export function createLiveChoir(ctx) {
  const buffer = noiseBuffer(ctx);
  const wave = sawWave(ctx);
  const bus = ctx.createGain();
  bus.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 18;
  comp.ratio.value = 2.6;
  comp.attack.value = 0.012;
  comp.release.value = 0.28;
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  bus.connect(comp);
  comp.connect(dry);
  comp.connect(conv);
  conv.connect(wet);
  dry.connect(ctx.destination);
  wet.connect(ctx.destination);
  dry.connect(analyser);

  const macro = {
    vowelX: 0.5,
    vowelY: 0.78,
    choirSize: 6,
    breathiness: 0.26,
    vibrato: 0.38,
    vibratoRate: 5,
    reverb: 0.7,
  };
  const notes = new Map();
  const order = [];

  function applyReverb() {
    const now = ctx.currentTime;
    wet.gain.setTargetAtTime(macro.reverb * 0.9, now, 0.04);
    dry.gain.setTargetAtTime(1 - macro.reverb * 0.25, now, 0.04);
  }

  function tune(group) {
    const timbre = timbreAt(macro.vowelX, macro.vowelY);
    const now = ctx.currentTime;
    const level = (0.34 / Math.sqrt(group.layout.length)) * group.velocity;
    group.level = level;
    group.layout.forEach((spec, index) => {
      const singer = group.singers[index];
      const hz = midiToHz(group.midi) * 2 ** (spec.cents / 1200);
      singer.osc.frequency.setTargetAtTime(hz, now, 0.03);
      singer.lfo.frequency.setTargetAtTime(macro.vibratoRate * spec.vibRateScale, now, 0.05);
      const depth = hz * (2 ** ((macro.vibrato * 48) / 1200) - 1);
      singer.lfoGain.gain.setTargetAtTime(depth, now, 0.05);
      singer.tone.gain.setTargetAtTime(1 - macro.breathiness * 0.62, now, 0.04);
      singer.noiseGain.gain.setTargetAtTime(macro.breathiness * 0.75, now, 0.04);
      singer.panner.pan.setTargetAtTime(clamp(spec.pan, -1, 1), now, 0.03);
      for (let k = 0; k < 4; k++) {
        const freq = clamp(timbre.f[k] * spec.fMul[k], 80, 7600);
        const q = clamp(freq / Math.max(30, timbre.bw[k]), 0.8, 14);
        singer.filters[k].frequency.setTargetAtTime(freq, now, 0.045);
        singer.filters[k].Q.setTargetAtTime(q, now, 0.045);
        singer.gains[k].gain.setTargetAtTime(timbre.a[k] * 1.6, now, 0.045);
      }
    });
  }

  function attack(group) {
    const now = ctx.currentTime;
    group.singers.forEach((singer, index) => {
      const spec = group.layout[index];
      const gain = singer.amp.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(0, now);
      gain.setValueAtTime(0, now + spec.delay);
      gain.linearRampToValueAtTime(group.level, now + spec.delay + spec.attack);
    });
  }

  function release(group) {
    if (!group || group.releasing) return;
    group.releasing = true;
    const now = ctx.currentTime;
    const stopAt = now + 0.58;
    for (const singer of group.singers) {
      const gain = singer.amp.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + 0.46);
      try {
        singer.osc.stop(stopAt);
        singer.lfo.stop(stopAt);
        singer.noise.stop(stopAt);
      } catch { /* already stopped */ }
    }
    setTimeout(() => group.singers.forEach(disconnectSinger), 750);
  }

  function noteOn(midi, velocity = 0.9) {
    const note = clamp(Math.round(midi), 0, 127);
    const vel = clamp(velocity, 0.05, 1);
    if (notes.has(note)) {
      release(notes.get(note));
      notes.delete(note);
    }
    while (notes.size >= 8) {
      const oldest = order.shift();
      if (oldest == null) break;
      const group = notes.get(oldest);
      if (group) {
        release(group);
        notes.delete(oldest);
      }
    }
    const layout = singerLayout(macro.choirSize);
    const singers = layout.map(() => spawnSinger(ctx, bus, buffer, wave));
    const group = { midi: note, velocity: vel, layout, singers, releasing: false, level: 0 };
    tune(group);
    attack(group);
    notes.set(note, group);
    order.push(note);
  }

  function noteOff(midi) {
    const note = Math.round(midi);
    const group = notes.get(note);
    if (!group) return;
    notes.delete(note);
    const index = order.indexOf(note);
    if (index >= 0) order.splice(index, 1);
    release(group);
  }

  function allOff() {
    for (const note of [...notes.keys()]) noteOff(note);
  }

  function setVowel(x, y) {
    macro.vowelX = clamp(x, 0, 1);
    macro.vowelY = clamp(y, 0, 1);
    for (const group of notes.values()) tune(group);
  }

  function setMacro(next) {
    const size = next.choirSize == null ? macro.choirSize : clamp(Math.round(next.choirSize), 1, 8);
    const sizeChanged = size !== macro.choirSize;
    Object.assign(macro, next, { choirSize: size });
    applyReverb();
    if (sizeChanged) {
      const held = [...notes.entries()].map(([midi, group]) => ({ midi, velocity: group.velocity }));
      allOff();
      for (const item of held) noteOn(item.midi, item.velocity);
    } else {
      for (const group of notes.values()) tune(group);
    }
  }

  applyReverb();
  return { noteOn, noteOff, allOff, setVowel, setMacro, analyser };
}
