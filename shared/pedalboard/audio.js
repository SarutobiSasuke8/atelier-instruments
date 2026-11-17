const modules = new WeakMap();
export async function getPedalDsp() {
  try { return await import('/__atelier-dsp/src/pedalboard/index.js'); }
  catch (error) { throw new Error('Set ATELIER_DSP_ROOT to a checkout containing the private pedal DSP.',{cause:error}); }
}
export async function createBrowserChain(context,pedals) {
  if (!modules.has(context)) {
    const ready=context.audioWorklet.addModule(new URL('./worklet.js',import.meta.url)).catch(error=>{modules.delete(context);throw error;});
    modules.set(context,ready);
  }
  await modules.get(context);
  return new AudioWorkletNode(context,'atelier-pedal-chain',{
    numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{pedals},
  });
}
export function footClick(context,destination) {
  const clip=context.createBuffer(1,Math.ceil(context.sampleRate*.025),context.sampleRate), data=clip.getChannelData(0);
  let seed=4767;
  for(let i=0;i<data.length;i++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    data[i]=(.32*Math.sin(i/context.sampleRate*Math.PI*2*164)+(seed/2147483648-1)*.12)*Math.exp(-i/(context.sampleRate*.004));
  }
  const source=context.createBufferSource(), level=context.createGain();
  source.buffer=clip;level.gain.value=.055;
  source.connect(level).connect(destination); source.start();
  source.onended=()=>{source.disconnect();level.disconnect();};
}
