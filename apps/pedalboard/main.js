import { mountPedalboard } from '../../shared/pedalboard/board.js';
const el=id=>document.getElementById(id);
const say=text=>{el('signal').textContent=text;};
let context,input,output,stream,device='',meter;
function action(id,fn){
  el(id).addEventListener('click',async()=>{try{await fn();}catch(error){say(error.message);}});
}
async function refresh(){
  if(!navigator.mediaDevices)throw new Error('Use the local server to access audio devices.');
  const listed=await navigator.mediaDevices.enumerateDevices();
  el('device').replaceChildren(new Option('Default input',''));
  for(const [index,item] of listed.filter(item=>item.kind==='audioinput'&&item.deviceId&&item.deviceId!=='default').entries())
    el('device').append(new Option(item.label||`Input ${index+1}`,item.deviceId));
  el('device').value=device;
}
async function toggleInput(){
  if(!context)throw new Error('Connect the local DSP first.');
  if(stream){stream.getTracks().forEach(track=>track.stop());stream=null;el('live').setAttribute('aria-pressed','false');say('Live input off.');return;}
  await context.resume();
  stream=await navigator.mediaDevices.getUserMedia({audio:{
    echoCancellation:false,autoGainControl:false,noiseSuppression:false,...(device?{deviceId:{exact:device}}:{})
  }});
  context.createMediaStreamSource(stream).connect(input);
  el('live').setAttribute('aria-pressed','true');say('Live input on.');await refresh();
}
function phrase(sr){
  const out=new Float32Array(Math.ceil(sr*2.8));
  const notes=[40,47,45,51,43,50,45,52];
  for(let i=0;i<out.length;i++){
    const time=i/sr, n=Math.min(notes.length-1,Math.floor(time/.31)), t=time-n*.31, hz=440*2**((notes[n]-69)/12);
    out[i]=.28*Math.min(1,t*340)*Math.exp(-t*8)*(.58*Math.sin(t*hz*6.283185)+.25*Math.sin(t*hz*12.56637)+.12*Math.sin(t*hz*18.84956));
  }
  return out;
}
async function start(){
  context=new AudioContext({latencyHint:'interactive'});
  input=context.createGain();output=context.createGain();output.gain.value=.52;
  const analyser=context.createAnalyser();
  analyser.fftSize=1024;output.connect(analyser).connect(context.destination);
  const data=new Float32Array(analyser.fftSize);
  meter=setInterval(()=>{analyser.getFloatTimeDomainData(data);const peak=data.reduce((power,sample)=>Math.max(power,Math.abs(sample)),0);el('peak').style.width=Math.min(100,peak*110)+'%';},60);
  try{
    await mountPedalboard({host:el('host'),context,input,destination:output});
    say('Board ready.');
  }catch(error){
    clearInterval(meter);await context.close();context=null;
    const message=document.createElement('p');message.className='alert';message.textContent=error.message;
    el('host').replaceChildren(message);say('DSP unavailable.');
  }
}
el('device').addEventListener('change',async()=>{
  const running=!!stream;
  if(running)await toggleInput();
  device=el('device').value;
  if(running){try{await toggleInput();}catch(error){say(error.message);}}
});
el('master').addEventListener('input',()=>{if(context&&output)output.gain.setTargetAtTime(Number(el('master').value)/100,context.currentTime,.012);});
action('refresh',refresh);action('live',toggleInput);
action('demo',async()=>{
  if(!context)throw new Error('Connect the local DSP first.');
  await context.resume();
  const clips=phrase(context.sampleRate), buffer=context.createBuffer(1,clips.length,context.sampleRate), source=context.createBufferSource();
  buffer.copyToChannel(clips,0);source.buffer=buffer;source.connect(input);source.start();source.onended=()=>source.disconnect();say('Playing the test phrase.');
});
window.addEventListener('pagehide',()=>stream?.getTracks().forEach(track=>track.stop()));
start();
refresh().catch(()=>{});
