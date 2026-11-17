import { createPedalChain } from '/__atelier-dsp/src/pedalboard/index.js';

class AtelierBoard extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chain=createPedalChain(sampleRate,options.processorOptions?.pedals);
    this.stereo=new Float64Array(2);
    this.loopState='empty';
    this.port.onmessage=event=>{
      if(event.data?.type==='loop') this.chain.loopCommand?.(event.data.action);
      else this.chain.set(event.data);
    };
  }
  process(inputs,outputs) {
    const [l,r]=inputs[0], [left,right]=outputs[0];
    for(let i=0;i<left.length;i++){
      this.chain.process(l?.[i]??0,r?.[i]??l?.[i]??0,this.stereo);
      left[i]=this.stereo[0];right[i]=this.stereo[1];
    }
    const loop=this.chain.loopStatus?.();
    if(loop&&loop.state!==this.loopState){
      this.loopState=loop.state;
      this.port.postMessage({type:'loop',...loop});
    }
    return true;
  }
}
registerProcessor('atelier-pedal-chain',AtelierBoard);
