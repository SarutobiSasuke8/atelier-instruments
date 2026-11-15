/* Atelier Instruments — MIT License. Live clock, synth voices, MIDI, and the note bus. */
import { eventsForStep, mulberry32, stepStartBeat } from "../engine.js";
import { openAtelierBus } from "../../../shared/midi.js";

const WAVE = {
  saw: "sawtooth",
  square: "square",
  triangle: "triangle",
  sine: "sine",
};

export function createPlayer() {
  let ctx = null;
  let master = null;
  let analyser = null;
  let timer = 0;
  let playing = false;
  let nextStep = 0;
  let origin = 0;
  let local = 0;
  let token = "";
  let rng = null;
  let seed = 0;
  let bpm = 120;
  let rate = 4;
  let swing = 0;
  let stepListener = () => {};
  let output = null;
  let currentSnap = () => null;
  const bus = openAtelierBus();
  const timers = new Set();
  const voices = [];
  const sounding = new Set();

  function ensure() {
    if (ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioCtx();
    master = ctx.createGain();
    master.gain.value = 0.75;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 16;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    master.connect(comp);
    comp.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function later(ms, fn) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, Math.max(0, ms));
    timers.add(id);
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  function silenceMidi(snap) {
    const channel = Math.max(1, Math.min(16, snap?.midi?.channel || 1));
    const status = channel - 1;
    if (output) {
      try {
        output.send([0xb0 | status, 123, 0]);
      } catch {
        /* port closed */
      }
      for (const note of sounding) {
        try {
          output.send([0x80 | status, note, 0]);
        } catch {
          /* ignore */
        }
      }
    }
    if (snap?.midi?.bus !== false) {
      bus.post({ source: "arp-lab", type: "allnotesoff", channel });
    }
    sounding.clear();
  }

  function killVoices() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of voices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
        voice.osc.stop(now + 0.06);
      } catch {
        /* already stopped */
      }
    }
    voices.length = 0;
  }

  function playHit(hit, when, snap) {
    const seconds = 60 / snap.bpm;
    const duration = Math.max(0.03, hit.duration * seconds);
    const start = Math.max(when, ctx.currentTime + 0.005);
    const synth = snap.synth;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = WAVE[synth.waveform] || "sawtooth";
    osc.frequency.setValueAtTime(440 * 2 ** ((hit.note - 69) / 12), start);
    filter.type = "lowpass";
    const cutoff = Math.max(70, Math.min(12000, synth.cutoff));
    const opened = Math.min(12000, cutoff * (hit.accent ? 1.65 : 1.2));
    filter.frequency.setValueAtTime(opened, start);
    filter.frequency.exponentialRampToValueAtTime(cutoff, start + Math.min(0.2, duration));
    filter.Q.setValueAtTime(0.4 + synth.resonance * 11, start);

    const peak = Math.max(0.0002, (hit.velocity / 127) * 0.28);
    const attack = Math.min(Math.max(0.004, synth.attack), duration * 0.45);
    const release = Math.max(0.02, synth.release);
    const body = Math.max(0.0002, peak * Math.max(0.02, synth.sustain));
    const attackEnd = start + attack;
    const gateEnd = start + duration;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, attackEnd);
    if (gateEnd > attackEnd + 0.004) gain.gain.exponentialRampToValueAtTime(body, gateEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, gateEnd + release);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(start);
    const stopAt = gateEnd + release + 0.03;
    osc.stop(stopAt);
    const voice = { osc, gain, filter };
    voices.push(voice);
    osc.onended = () => {
      try {
        osc.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch {
        /* gone */
      }
      const index = voices.indexOf(voice);
      if (index >= 0) voices.splice(index, 1);
    };
    if (voices.length > 36) {
      const old = voices.shift();
      try {
        old.osc.onended = null;
        old.osc.stop();
      } catch {
        /* ignore */
      }
    }

    const channel = Math.max(1, Math.min(16, snap.midi.channel || 1));
    const status = channel - 1;
    const velocity = Math.max(1, Math.min(127, hit.velocity | 0));
    if (snap.midi.output && output) {
      const stamp = performance.now() + (start - ctx.currentTime) * 1000;
      const offStamp = stamp + duration * 1000;
      try {
        output.send([0x90 | status, hit.note, velocity], stamp);
        output.send([0x80 | status, hit.note, 0], offStamp);
        sounding.add(hit.note);
      } catch {
        /* disconnected port */
      }
    }
    if (snap.midi.bus) {
      const delay = Math.max(0, (start - ctx.currentTime) * 1000);
      later(delay, () => {
        bus.post({ source: "arp-lab", type: "noteon", note: hit.note, velocity, channel });
      });
      later(delay + duration * 1000, () => {
        bus.post({ source: "arp-lab", type: "noteoff", note: hit.note, channel });
      });
    }
  }

  function pump() {
    const snap = currentSnap();
    if (!snap || !ctx) return;
    try {
      if (snap.bpm !== bpm || snap.arp.rate !== rate || snap.arp.swing !== swing) {
        bpm = snap.bpm;
        rate = snap.arp.rate;
        swing = snap.arp.swing;
        const beat = stepStartBeat(nextStep, snap.arp);
        origin = ctx.currentTime + 0.04 - beat * (60 / bpm);
      }
      if ((snap.arp.seed >>> 0) !== seed) {
        seed = snap.arp.seed >>> 0;
        rng = mulberry32(seed || 1);
      }
      master.gain.setTargetAtTime(Math.max(0.0001, snap.synth.gain), ctx.currentTime, 0.04);
      const horizon = ctx.currentTime + 0.11;
      const seconds = 60 / bpm;
      for (let guard = 0; guard < 48; guard++) {
        const beat = stepStartBeat(nextStep, snap.arp);
        const when = origin + beat * seconds;
        if (when > horizon) break;
        if (when >= ctx.currentTime - 0.03) {
          const notes = snap.notesAt(beat) || [];
          const mark = `${snap.phraseAt(beat)}|${notes.join(",")}`;
          if (mark !== token) {
            token = mark;
            local = 0;
          }
          if (notes.length) {
            const hits = eventsForStep(notes, local, nextStep, snap.arp, rng);
            local += 1;
            for (const hit of hits) playHit(hit, when + hit.offset * seconds, snap);
          }
          stepListener(nextStep);
        }
        nextStep += 1;
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function resume(getSnapshot) {
    currentSnap = getSnapshot;
    ensure();
    if (ctx.state === "suspended") await ctx.resume();
    return currentSnap();
  }

  return {
    get playing() {
      return playing;
    },
    analyser() {
      return analyser;
    },
    context() {
      return ctx;
    },
    setOutput(port) {
      output = port || null;
    },
    onStep(fn) {
      stepListener = typeof fn === "function" ? fn : () => {};
    },
    async preview(notes, getSnapshot) {
      if (!notes?.length || playing) return;
      const snap = await resume(getSnapshot);
      const when = ctx.currentTime + 0.03;
      notes.forEach((note, index) => {
        playHit(
          { note, duration: 0.55, velocity: index === 0 ? 110 : 88, accent: index === 0 },
          when + index * 0.018,
          snap,
        );
      });
    },
    async start(getSnapshot) {
      const snap = await resume(getSnapshot);
      if (playing) this.stop();
      playing = true;
      nextStep = 0;
      local = 0;
      token = "";
      bpm = snap.bpm;
      rate = snap.arp.rate;
      swing = snap.arp.swing;
      seed = snap.arp.seed >>> 0;
      rng = mulberry32(seed || 1);
      origin = ctx.currentTime + 0.06;
      clearInterval(timer);
      pump();
      timer = setInterval(pump, 25);
    },
    stop() {
      playing = false;
      clearInterval(timer);
      timer = 0;
      clearTimers();
      const snap = currentSnap() || { midi: { channel: 1, bus: true } };
      killVoices();
      silenceMidi(snap);
      stepListener(-1);
    },
  };
}
