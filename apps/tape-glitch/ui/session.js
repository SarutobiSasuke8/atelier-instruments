import { createTapeMachine } from "../engine.js";
import { createBlocker, dcBlock, peakOf } from "./output.js";

function copyChannels(channels) {
  return channels.map((channel) => new Float32Array(channel));
}

export async function openSession(ctx, { channels, preset, onMeter }) {
  if (ctx.audioWorklet) {
    try {
      return await openWorklet(ctx, { channels, preset, onMeter });
    } catch (error) {
      console.warn("Tape worklet unavailable, using the main-thread deck.", error);
    }
  }
  return openScript(ctx, { channels, preset, onMeter });
}

async function openWorklet(ctx, { channels, preset, onMeter }) {
  await ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
  const node = new AudioWorkletNode(ctx, "tape-deck");
  const gain = ctx.createGain();
  node.connect(gain);
  gain.connect(ctx.destination);
  let rolling = false;
  let currentPreset = preset;
  let takeWait = null;

  node.port.onmessage = (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "meter" && onMeter) onMeter(message);
    if (message.type === "take" && takeWait) {
      const resolve = takeWait;
      takeWait = null;
      resolve(message);
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tape deck did not start")), 2000);
    const previous = node.port.onmessage;
    node.port.onmessage = (event) => {
      if (event.data?.type === "ready") {
        clearTimeout(timer);
        node.port.onmessage = previous;
        resolve();
        return;
      }
      previous(event);
    };
    node.port.postMessage({
      type: "init",
      channels: copyChannels(channels),
      preset,
    });
  }).catch((error) => {
    node.disconnect();
    gain.disconnect();
    throw error;
  });

  return {
    hold(name, down) {
      node.port.postMessage({ type: "hold", name, down: !!down });
    },
    setScratch(value) {
      node.port.postMessage({ type: "scratch", value });
    },
    setRolling(on) {
      rolling = !!on;
      node.port.postMessage({ type: "rolling", on: rolling });
    },
    setPreset(next) {
      currentPreset = next;
      node.port.postMessage({ type: "preset", preset: next });
    },
    seek(norm) {
      node.port.postMessage({ type: "seek", norm });
    },
    load(nextChannels) {
      node.port.postMessage({
        type: "load",
        channels: copyChannels(nextChannels),
        preset: currentPreset,
      });
      node.port.postMessage({ type: "rolling", on: rolling });
    },
    clearTake() {
      node.port.postMessage({ type: "clear" });
    },
    requestTake() {
      return new Promise((resolve) => {
        takeWait = resolve;
        node.port.postMessage({ type: "take" });
      });
    },
    close() {
      node.disconnect();
      gain.disconnect();
    },
  };
}

function openScript(ctx, { channels, preset, onMeter }) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const node = ctx.createScriptProcessor(512, 0, 2);
  let machine = createTapeMachine({
    channels,
    sampleRate: ctx.sampleRate,
    preset,
    loop: true,
    rolling: false,
  });
  let channelCount = channels.length;
  const recCap = Math.floor(ctx.sampleRate * 45);
  let recL = new Float32Array(recCap);
  let recR = new Float32Array(recCap);
  let recN = 0;
  let capped = false;
  const blockL = createBlocker();
  const blockR = createBlocker();
  const tmp = [new Float32Array(512), new Float32Array(512)];
  let ticks = 0;

  node.onaudioprocess = (event) => {
    const frames = event.outputBuffer.length;
    const left = event.outputBuffer.getChannelData(0);
    const right = event.outputBuffer.getChannelData(1);
    if (!machine.isRolling() && !machine.isScratching()) {
      left.fill(0);
      right.fill(0);
    } else {
      const count = channelCount > 1 ? 2 : 1;
      const outs = count === 1 ? [tmp[0].subarray(0, frames)] : [tmp[0].subarray(0, frames), tmp[1].subarray(0, frames)];
      machine.renderBlock(outs, frames);
      const wetL = outs[0];
      const wetR = outs[1] || outs[0];
      if (machine.isScratching()) {
        dcBlock(wetL, blockL);
        if (outs[1]) dcBlock(wetR, blockR);
      }
      left.set(wetL);
      right.set(wetR);
      const room = Math.min(frames, recCap - recN);
      if (room > 0) {
        recL.set(wetL.subarray(0, room), recN);
        recR.set(wetR.subarray(0, room), recN);
        recN += room;
      }
      if (room < frames) capped = true;
    }
    ticks += 1;
    if (onMeter && ticks % 4 === 0) {
      onMeter({
        type: "meter",
        peakL: peakOf(left),
        peakR: peakOf(right),
        head: machine.getHead(),
        rolling: machine.isRolling(),
        scratching: machine.isScratching(),
        take: recN,
        capped,
      });
    }
  };
  node.connect(gain);

  return {
    hold(name, down) {
      machine.hold(name, down);
    },
    setScratch(value) {
      machine.setScratch(value);
    },
    setRolling(on) {
      machine.setRolling(on);
    },
    setPreset(next) {
      machine.setPreset(next);
    },
    seek(norm) {
      machine.seek(norm);
    },
    load(nextChannels) {
      const rolling = machine.isRolling();
      const nextPreset = machine.getPreset();
      channelCount = nextChannels.length > 1 ? 2 : 1;
      machine = createTapeMachine({
        channels: nextChannels,
        sampleRate: ctx.sampleRate,
        preset: nextPreset,
        loop: true,
        rolling,
      });
      recN = 0;
      capped = false;
    },
    clearTake() {
      recN = 0;
      capped = false;
    },
    requestTake() {
      const left = recL.slice(0, recN);
      const right = recR.slice(0, recN);
      const samples = recN;
      recN = 0;
      return Promise.resolve({
        type: "take",
        left,
        right,
        sampleRate: ctx.sampleRate,
        samples,
        capped,
      });
    },
    close() {
      node.onaudioprocess = null;
      node.disconnect();
      gain.disconnect();
    },
  };
}
