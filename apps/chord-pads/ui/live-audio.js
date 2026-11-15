import { voiceRecipe } from "../engine.js";

function freqOf(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function rampDown(param, time, release) {
  const now = Math.max(time, param.value === 0 ? time : time);
  const current = Math.max(0.0001, param.value || 0.0001);
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.exponentialRampToValueAtTime(0.0001, now + Math.max(0.03, release));
}

function shapeGain(gain, recipe, time, velocity, duration) {
  const peak = Math.max(0.0002, velocity * recipe.gain);
  const sustain = Math.max(0.0002, peak * Math.max(recipe.sustain, 0.0001));
  const attack = Math.max(0.005, recipe.attack);
  const decay = Math.max(0.02, recipe.decay);
  gain.cancelScheduledValues(time);
  gain.setValueAtTime(0.0001, time);
  gain.exponentialRampToValueAtTime(peak, time + attack);
  gain.exponentialRampToValueAtTime(sustain, time + attack + decay);
  if (duration == null) return;
  const relStart = time + Math.max(duration, attack + decay);
  gain.setValueAtTime(sustain, relStart);
  gain.exponentialRampToValueAtTime(0.0001, relStart + Math.max(0.03, recipe.release));
}

function stopAll(nodes, when) {
  for (const node of nodes) {
    try {
      node.stop(when);
    } catch {
      /* already stopped */
    }
  }
}

export function createLiveOutput(ctx) {
  const master = ctx.createGain();
  master.gain.value = 0.85;
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 35;
  master.connect(highpass);
  highpass.connect(ctx.destination);
  const active = new Set();

  function track(group) {
    active.add(group);
    return group;
  }

  function spawn(midi, recipe, velocity, start, duration) {
    const time = Math.max(start, ctx.currentTime + 0.005);
    const gain = ctx.createGain();
    shapeGain(gain.gain, recipe, time, velocity, duration);
    gain.connect(master);
    const nodes = [];
    const stopAt = duration == null ? null : time + duration + recipe.release + 0.06;

    if (recipe.kind === "additive") {
      for (const partial of recipe.partials) {
        const osc = ctx.createOscillator();
        const partialGain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freqOf(midi) * partial.ratio;
        partialGain.gain.setValueAtTime(Math.max(0.0001, partial.amp), time);
        partialGain.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.12, partial.decay * 1.5));
        osc.connect(partialGain);
        partialGain.connect(gain);
        osc.start(time);
        if (stopAt) osc.stop(stopAt);
        nodes.push(osc);
      }
    } else if (recipe.kind === "pluck") {
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = freqOf(midi);
      filter.Q.value = 3;
      filter.connect(gain);
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freqOf(midi);
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + 0.45);
      nodes.push(osc);
      const noise = ctx.createBufferSource();
      const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.03)), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noise.buffer = buffer;
      noise.connect(filter);
      noise.start(time);
      noise.stop(time + 0.04);
      nodes.push(noise);
    } else {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.65;
      filter.frequency.setValueAtTime(Math.max(120, recipe.cutoff * 0.55), time);
      filter.frequency.linearRampToValueAtTime(recipe.cutoff, time + Math.max(0.02, recipe.attack));
      filter.connect(gain);
      const unison = recipe.unison ?? 1;
      for (let index = 0; index < unison; index++) {
        const spread = unison === 1 ? 0 : index / (unison - 1) - 0.5;
        const osc = ctx.createOscillator();
        const panner = ctx.createStereoPanner();
        osc.type = "sawtooth";
        osc.frequency.value = freqOf(midi);
        osc.detune.value = spread * 2 * (recipe.detune ?? 0);
        panner.pan.value = spread * 0.7;
        osc.connect(panner);
        panner.connect(filter);
        osc.start(time);
        if (stopAt) osc.stop(stopAt);
        nodes.push(osc);
      }
    }

    return {
      release(at = ctx.currentTime) {
        rampDown(gain.gain, Math.max(at, ctx.currentTime), recipe.release);
        stopAll(nodes, Math.max(at, ctx.currentTime) + recipe.release + 0.05);
      },
      cut(at = ctx.currentTime) {
        rampDown(gain.gain, Math.max(at, ctx.currentTime), 0.03);
        stopAll(nodes, Math.max(at, ctx.currentTime) + 0.05);
      },
    };
  }

  function play(noteEvents, options) {
    const recipe = voiceRecipe(options.sound);
    const when = options.when ?? ctx.currentTime;
    const velocity = options.velocity ?? 0.8;
    const duration = options.duration ?? null;
    const voices = noteEvents.map((event) =>
      spawn(event.note, recipe, velocity, when + (event.delay || 0), duration),
    );
    const group = track({
      release(at) {
        for (const voice of voices) voice.release(at);
        active.delete(group);
      },
      cut(at) {
        for (const voice of voices) voice.cut(at);
        active.delete(group);
      },
    });
    if (duration != null) {
      const tail = duration + noteEvents.reduce((max, event) => Math.max(max, event.delay || 0), 0) + recipe.release;
      const timer = setTimeout(() => active.delete(group), Math.max(0, (when + tail - ctx.currentTime) * 1000));
      group.cancel = () => clearTimeout(timer);
    }
    return group;
  }

  function click(time, accent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1560 : 1040;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.05 : 0.028, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);
    osc.connect(gain);
    gain.connect(master);
    osc.start(time);
    osc.stop(time + 0.04);
  }

  return {
    ctx,
    play,
    click,
    panic() {
      for (const group of [...active]) {
        group.cancel?.();
        group.cut(ctx.currentTime);
      }
      active.clear();
    },
    setVolume(value) {
      master.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), ctx.currentTime, 0.02);
    },
  };
}
