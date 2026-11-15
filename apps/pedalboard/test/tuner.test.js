import assert from 'node:assert/strict';
import test from 'node:test';
import {createPitchDetector,tuningNote} from '../../../shared/pedalboard/tuner.js';

test('recognises low strings, harmonics, and cents at common device rates',()=>{
  for(const rate of [44100,48000,96000]){
    const input=new Float32Array(8192);
    const detect=createPitchDetector(rate,input.length);
    assert.equal(detect(input),null);
    for(const [hz,note,cents] of [[41.203,'E1',0],[82.407,'E2',0],[110,'A2',0],[445.115,'A4',20]]){
      for(let i=0;i<input.length;i++){
        const phase=2*Math.PI*hz*i/rate;
        input[i]=.08*Math.sin(phase)+.14*Math.sin(2*phase)+.035*Math.sin(3*phase);
      }
      const result=tuningNote(detect(input));
      assert.equal(result.note,note);
      assert.ok(Math.abs(result.cents-cents)<=2,`${rate} ${hz} ${result.cents}`);
    }
    let seed=54321;
    for(let i=0;i<input.length;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      input[i]=(seed/2147483648-1)*.1;
    }
    assert.equal(detect(input),null);
  }
});
