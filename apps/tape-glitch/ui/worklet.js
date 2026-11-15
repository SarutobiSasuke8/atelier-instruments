import { createTapeMachine } from "../engine.js";
import { createBlocker, dcBlock, peakOf } from "./output.js";

class TapeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.machine = null;
    this.channels = 1;
    this.rolling = false;
    this.blockL = createBlocker();
    this.blockR = createBlocker();
    this.tmp = [];
    this.recL = null;
    this.recR = null;
    this.recN = 0;
    this.cap = 0;
    this.capped = false;
    this.since = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(message) {
    if (!message) return;
    if (message.type === "init" || message.type === "load") {
      const channels = message.channels.map((channel) =>
        channel instanceof Float32Array ? channel : new Float32Array(channel),
      );
      this.machine = createTapeMachine({
        channels,
        sampleRate,
        preset: message.preset,
        loop: true,
        rolling: this.rolling,
      });
      this.channels = channels.length;
      this.blockL = createBlocker();
      this.blockR = createBlocker();
      this.cap = Math.floor(sampleRate * 45);
      this.recL = new Float32Array(this.cap);
      this.recR = new Float32Array(this.cap);
      this.recN = 0;
      this.capped = false;
      this.ensureTmp(128);
      this.port.postMessage({ type: "ready" });
      return;
    }
    if (!this.machine) return;
    if (message.type === "preset") this.machine.setPreset(message.preset);
    else if (message.type === "hold") this.machine.hold(message.name, message.down);
    else if (message.type === "scratch") this.machine.setScratch(message.value);
    else if (message.type === "rolling") this.machine.setRolling(message.on);
    else if (message.type === "seek") this.machine.seek(message.norm);
    else if (message.type === "clear") {
      this.recN = 0;
      this.capped = false;
    } else if (message.type === "take") {
      const n = this.recN;
      const left = this.recL.slice(0, n);
      const right = this.recR.slice(0, n);
      this.recN = 0;
      this.port.postMessage(
        { type: "take", left, right, sampleRate, samples: n, capped: this.capped },
        [left.buffer, right.buffer],
      );
    }
  }

  ensureTmp(frames) {
    const count = Math.max(1, this.channels);
    if (this.tmp.length === count && this.tmp[0].length >= frames) return;
    this.tmp = [];
    for (let c = 0; c < count; c++) this.tmp.push(new Float32Array(Math.max(256, frames)));
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out?.length) return true;
    const frames = out[0].length;
    if (!this.machine) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }
    const scratching = this.machine.isScratching();
    const rolling = this.machine.isRolling();
    if (!rolling && !scratching) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      this.emitMeter(0, 0);
      return true;
    }
    this.ensureTmp(frames);
    const slice = this.tmp.map((channel) => channel.subarray(0, frames));
    this.machine.renderBlock(slice, frames);
    if (scratching) {
      dcBlock(slice[0], this.blockL);
      if (slice[1]) dcBlock(slice[1], this.blockR);
    }
    const left = slice[0];
    const right = slice[1] || slice[0];
    out[0].set(left);
    if (out[1]) out[1].set(right);
    this.record(left, right, frames);
    this.emitMeter(peakOf(left), peakOf(right));
    return true;
  }

  record(left, right, frames) {
    if (!this.recL || this.recN >= this.cap) {
      this.capped = true;
      return;
    }
    const room = Math.min(frames, this.cap - this.recN);
    this.recL.set(left.subarray(0, room), this.recN);
    this.recR.set(right.subarray(0, room), this.recN);
    this.recN += room;
    if (room < frames) this.capped = true;
  }

  emitMeter(peakL, peakR) {
    this.since += 1;
    if (this.since < 8) return;
    this.since = 0;
    this.port.postMessage({
      type: "meter",
      peakL,
      peakR,
      head: this.machine.getHead(),
      rolling: this.machine.isRolling(),
      scratching: this.machine.isScratching(),
      take: this.recN,
      capped: this.capped,
    });
  }
}

registerProcessor("tape-deck", TapeProcessor);
