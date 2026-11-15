import { createBrowserChain, getPedalDsp, footClick } from './audio.js';
import { format, readPreset, formatControl } from './preset.js';
import { createPitchDetector, tuningNote } from './tuner.js';

const styles=['pedalboard.css','faceplates.css'].map(file=>new URL(file,import.meta.url));
const node = (tag, props={}, label) => {
  const item=document.createElement(tag);
  for(const [name,value] of Object.entries(props)){if(name==='class')item.className=value;else item.setAttribute(name,value);}
  if(label!==undefined)item.textContent=label;
  return item;
};
const clamp = value => Math.min(1,Math.max(0,value));
const ns = 'http://www.w3.org/2000/svg';
function installStyle(){
  for(const stylesheet of styles){
    if(!document.querySelector(`link[href="${stylesheet.href}"]`))
      document.head.append(node('link',{rel:'stylesheet',href:stylesheet.href}));
  }
}
const effectLabels = {
  eleven: 'Overdrive',
  walnut: 'Fuzz',
  tape: 'Tape Delay',
  phaser: 'Phaser',
  chorus: 'Chorus',
  wah: 'Wah',
  octafuzz: 'Octave Fuzz',
  metal: 'Metal Distortion',
  gate: 'Noise Gate',
  doom: 'Octave Down',
  spring: 'Spring Reverb',
  tremolo: 'Tremolo',
  compressor: 'Compressor',
  flanger: 'Flanger',
  distortion: 'Rock Distortion',
  eq: 'Graphic EQ + Boost',
  looper: 'Stereo Looper',
  tuner: 'Tuner + Mute',
};
const portraitArt = new Set(['spring','tremolo','compressor','flanger','distortion','eq','looper','tuner']);
export async function mountPedalboard({ host, context, input, destination=context.destination, initial, onChange=()=>{} }) {
  installStyle();
  const dsp=await getPedalDsp();
  const original=dsp.pedals;
  const board=node('div',{class:'pedalboard'});
  const toolbar=node('div',{class:'pedal-tools'});
  const midiButton=node('button',{type:'button'},'Connect MIDI');
  const learnButton=node('button',{type:'button','aria-pressed':'false'},'MIDI learn');
  const saveButton=node('button',{type:'button'},'Save preset');
  const loadButton=node('button',{type:'button'},'Load preset');
  const file=node('input',{type:'file',accept:'application/json,.json',hidden:''});
  const status=node('output',{'aria-live':'polite'});
  const tray=node('div',{class:'pedal-tray'});
  const cables=document.createElementNS(ns,'svg');cables.setAttribute('class','patch-cables');cables.setAttribute('aria-hidden','true');
  const cells=node('div',{class:'pedal-cells'});
  tray.append(cables,cells);toolbar.append(midiButton,learnButton,saveButton,loadButton,file,status);board.append(toolbar,tray);
  host.replaceChildren(board);
  let snapshot=initial?readPreset(initial,dsp.normalizePedalState):{format,pedals:dsp.normalizePedalState(),midi:[]};
  const chain=await createBrowserChain(context,snapshot.pedals);
  input.connect(chain).connect(destination);
  const pitchInput=context.createAnalyser();
  pitchInput.fftSize=8192;
  input.connect(pitchInput);
  const pitchSamples=new Float32Array(pitchInput.fftSize);
  const detectPitch=createPitchDetector(context.sampleRate,pitchSamples.length);
  let loop={state:'empty',seconds:0};
  chain.port.onmessage=({data})=>{
    if(data?.type==='loop'){
      loop=data;
      refreshLoop();
    }
  };
  let midi, learning=false, target, drag;
  const pressed=new Set();
  const cellsById=new Map();
  const specById=new Map(original.map(spec=>[spec.id,spec]));
  function emit(){
    chain.port.postMessage(snapshot.pedals);
    onChange(structuredClone(snapshot));
  }
  function choose(id,knob){
    if(!learning)return false;
    target={id,knob};status.textContent='Move a MIDI controller to assign it.';
    return true;
  }
  function move(id,destinationId){
    if(id===destinationId||id==='tuner'||destinationId==='tuner')return;
    const from=snapshot.pedals.findIndex(pedal=>pedal.id===id), to=snapshot.pedals.findIndex(pedal=>pedal.id===destinationId);
    if(from<0||to<0)return;
    snapshot.pedals.splice(to,0,...snapshot.pedals.splice(from,1));emit();draw();
  }
  function redrawCables(){
    cables.replaceChildren();
    const base=tray.getBoundingClientRect();
    cables.setAttribute('viewBox',`0 0 ${base.width} ${base.height}`);
    const order=snapshot.pedals.map(item=>cellsById.get(item.id).getBoundingClientRect());
    for(let i=1;i<order.length;i++) {
      const from=order[i-1],to=order[i],x=from.right-base.left,y=from.top+from.height*.58-base.top;
      const xx=to.left-base.left,yy=to.top+to.height*.58-base.top;
      const d=Math.abs(y-yy)<10?`M${x},${y} C${x+15},${y+23} ${xx-16},${yy+21} ${xx},${yy}`
        :`M${x},${y} C${base.width-2},${y+8} ${base.width-2},${y+103} ${base.width-23},${y+103} L23,${y+103} Q2,${y+103} 2,${yy-22} Q2,${yy} ${xx},${yy}`;
      for(const cls of ['cable-shadow','cable','cable-shine']) {
        const line=document.createElementNS(ns,'path');line.setAttribute('d',d);line.setAttribute('class',cls);cables.append(line);
      }
    }
  }
  function setValue(item,index,value) {
    item.controls[index]=clamp(value);emit();cellsById.get(item.id)?.knobs[index]?.refresh();
  }
  function setActive(item,active){
    item.bypass=!active;
    const cell=cellsById.get(item.id);
    cell.setAttribute('data-active',String(active));
    cell.switch.setAttribute('aria-pressed',String(active));
    emit();
  }
  function refreshLoop(){
    const cell=cellsById.get('looper');
    if(!cell)return;
    const labels={empty:'Ready',recording:'Recording',playing:'Playing',overdub:'Overdubbing',stopped:'Stopped'};
    const actions={empty:'Record loop',recording:'Play loop',playing:'Overdub loop',overdub:'Finish overdub',stopped:'Play loop'};
    cell.loopStatus.textContent=loop.seconds>0?`${labels[loop.state]} · ${loop.seconds.toFixed(2)} s`:labels[loop.state];
    cell.setAttribute('data-transport',loop.state);
    cell.switch.setAttribute('aria-label',actions[loop.state]);
    cell.switch.title=actions[loop.state];
    cell.switch.removeAttribute('aria-pressed');
    cell.stopLoop.disabled=!['recording','playing','overdub'].includes(loop.state);
    cell.clearLoop.disabled=loop.state==='empty';
  }
  function transport(action){
    const item=snapshot.pedals.find(pedal=>pedal.id==='looper');
    if(action==='toggle'&&item.bypass)setActive(item,true);
    void context.resume().catch(()=>{});
    chain.port.postMessage({type:'loop',action});
  }
  function refreshTuner(){
    const cell=cellsById.get('tuner');
    if(!cell)return;
    const on=cell.dataset.active==='true';
    cell.tunerScreen.dataset.live=String(on);
    cell.tunerNeedle.style.setProperty('--cents',0);
    if(on){
      pitchInput.getFloatTimeDomainData(pitchSamples);
      const hz=detectPitch(pitchSamples);
      if(hz){
        const {note,cents}=tuningNote(hz);
        cell.tunerNote.textContent=note;
        cell.tunerStatus.textContent=`${cents>0?'+':''}${cents} ¢ · Muted`;
        cell.tunerNeedle.style.setProperty('--cents',cents);
        cell.tunerScreen.dataset.inTune=String(Math.abs(cents)<=3);
        return;
      }
    }
    cell.tunerNote.textContent='—';
    cell.tunerStatus.textContent=on?'Play one string · Muted':'Bypass';
    cell.tunerScreen.dataset.inTune='false';
  }
  function stomp(item) {
    if(choose(item.id,-1))return;
    if(item.id==='looper'){transport('toggle');return;}
    setActive(item,item.bypass);
    const muted=snapshot.pedals.some(pedal=>pedal.id==='tuner'&&!pedal.bypass);
    if(item.id==='tuner')refreshTuner();
    void context.resume().then(()=>{
      if(item.id!=='tuner'&&!muted)footClick(context,destination);
    }).catch(()=>{});
  }
  function rocker(item){
    const holder=node('label',{class:'expression-rocker'});
    const range=node('input',{type:'range',min:'0',max:'1000',step:'1','aria-label':'Spectrum Melt Expression'});
    const tread=node('span',{class:'expression-tread','aria-hidden':'true'});
    holder.append(tread,range);
    function refresh(){
      const position=item.controls[0];
      range.value=String(Math.round(position*1000));
      range.setAttribute('aria-valuetext',`${Math.round(position*100)}% toe`);
      tread.style.setProperty('--tilt',`${(position-.5)*38}deg`);
    }
    range.addEventListener('pointerdown',event=>{if(choose(item.id,0))event.preventDefault();});
    range.addEventListener('keydown',event=>{
      if(['Enter',' '].includes(event.key)&&choose(item.id,0))event.preventDefault();
    });
    range.addEventListener('input',()=>{
      if(!learning)setValue(item,0,Number(range.value)/1000);
      else refresh();
    });
    refresh();
    return {holder,refresh};
  }
  function dial(item,spec,index){
    const holder=node('div',{class:'dial'}), button=node('button',{class:'knob',type:'button',role:'slider',tabindex:'0',
      'aria-label':`${spec.name} ${spec.controls[index]}`,'aria-valuemin':'0','aria-valuemax':spec.id==='eleven'&&index===0?'11':'100'});
    const amount=node('output',{class:'dial-value'}), caption=node('span',{class:'dial-label'},spec.controls[index]);
    const indicator=node('span',{class:'knob-pointer'});
    button.append(indicator);holder.append(caption,button,amount);
    let origin;
    function refresh(){
      const value=item.controls[index], formatted=formatControl(item.id,index,value);
      const readout=dsp.pedalControlText?.(item.id,index,value)??formatted;
      button.style.setProperty('--turn',`${value*268-134}deg`);
      button.setAttribute('aria-valuenow',formatted);
      button.setAttribute('aria-valuetext',readout);
      amount.textContent=readout;
    }
    button.addEventListener('pointerdown',event=>{
      if(choose(item.id,index)){event.preventDefault();return;}
      if(event.button!==0)return;
      origin={y:event.clientY,v:item.controls[index]};button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove',event=>{
      if(origin&&button.hasPointerCapture(event.pointerId))setValue(item,index,origin.v+(origin.y-event.clientY)*(event.shiftKey?.0015:.006));
    });
    const stop=()=>{origin=null;};
    button.addEventListener('lostpointercapture',stop);button.addEventListener('pointerup',stop);
    button.addEventListener('wheel',event=>{event.preventDefault();setValue(item,index,item.controls[index]-Math.sign(event.deltaY)*(event.shiftKey?.008:.045));},{passive:false});
    button.addEventListener('dblclick',()=>setValue(item,index,spec.defaults[index]));
    button.addEventListener('keydown',event=>{
      if(['Enter',' '].includes(event.key)&&choose(item.id,index)){event.preventDefault();return;}
      const sign=['ArrowUp','ArrowRight'].includes(event.key)?1:['ArrowDown','ArrowLeft'].includes(event.key)?-1:0;
      if(sign){event.preventDefault();setValue(item,index,item.controls[index]+sign*(event.shiftKey?.005:.03));}
    });
    refresh();return {holder,refresh};
  }
  function draw(){
    cells.replaceChildren();cellsById.clear();
    for(const [index,item] of snapshot.pedals.entries()){
      const spec=specById.get(item.id);
      const cell=node('article',{class:`pedal ${spec.family}`,'data-id':item.id,'data-active':String(!item.bypass),'aria-label':spec.name});
      const plate=node('div',{class:'enclosure'}), crown=node('header',{class:'face-label'});
      crown.append(node('span',{class:'pedal-series'},'Atelier'),node('h3',{class:'pedal-name'},spec.name),node('span',{class:'pedal-type'},effectLabels[spec.id]));
      const grips=node('div',{class:'knobs'});
      cell.knobs=spec.controls.map((_,i)=>item.id==='wah'&&i===0?rocker(item):dial(item,spec,i));
      grips.append(...cell.knobs.slice(item.id==='wah'?1:0).map(knob=>knob.holder));
      if(item.id==='tuner'){
        cell.tunerScreen=node('div',{class:'tuner-screen'});
        cell.tunerNote=node('output',{class:'tuner-note','aria-label':'Detected note'},'—');
        cell.tunerNeedle=node('span',{class:'tuner-needle','aria-hidden':'true'});
        cell.tunerStatus=node('span',{class:'tuner-status'},'Bypass');
        const scale=node('span',{class:'tuner-scale','aria-hidden':'true'});
        scale.append(cell.tunerNeedle);
        cell.tunerScreen.append(cell.tunerNote,scale,cell.tunerStatus);
        grips.append(cell.tunerScreen);
      }
      if(item.id==='looper'){
        cell.loopStatus=node('output',{class:'looper-status','aria-live':'polite'},'Ready');
        grips.append(cell.loopStatus);
      }
      const portrait=portraitArt.has(spec.id);
      const art=node('div',{class:portrait?'face-art':'face-art square-art','aria-hidden':'true'});
      const image=new URL(`./art/${spec.id}.webp`,import.meta.url).href;
      if(!portrait) art.style.setProperty('--art-image',`url("${image}")`);
      art.append(node('img',{src:image,alt:'',decoding:'async'}));
      const led=node('i',{class:'lamp','aria-hidden':'true'});
      const foot=node('button',{class:'stomp',type:'button','aria-label':`Bypass ${spec.name}`,'aria-pressed':String(!item.bypass)});
      if(item.id==='tuner')foot.setAttribute('aria-label','Mute and tune');
      if(spec.family==='black') foot.append(node('span',{'aria-hidden':'true'},'☠'));
      foot.addEventListener('click',()=>stomp(item));cell.switch=foot;
      const heel=node('div',{class:'heel'});heel.append(node('span',{},'I/O'),led,foot,node('span',{},'9V'));
      if(item.id==='looper'){
        cell.stopLoop=node('button',{class:'loop-action',type:'button','aria-label':'Stop loop'},'Stop');
        cell.clearLoop=node('button',{class:'loop-action',type:'button','aria-label':'Clear loop'},'Clear');
        cell.stopLoop.addEventListener('click',()=>transport('stop'));
        cell.clearLoop.addEventListener('click',()=>transport('clear'));
        heel.firstElementChild.replaceWith(cell.stopLoop);
        heel.lastElementChild.replaceWith(cell.clearLoop);
      }
      for(const name of ['tl','tr','bl','br'])plate.append(node('i',{class:`screw ${name}`,'aria-hidden':'true'}));
      const order=node('div',{class:'order'});
      const dragger=node('button',{type:'button',draggable:'true','aria-label':`Drag ${spec.name}`},'⠿');
      dragger.addEventListener('dragstart',event=>{drag=item.id;event.dataTransfer.setData('text/plain',item.id);});
      dragger.addEventListener('dragend',()=>{drag=null;});
      for(const [direction,label] of item.id==='tuner'?[]:[[-1,'←'],[1,'→']]){
        const button=node('button',{type:'button','aria-label':`Move ${spec.name} ${direction<0?'earlier':'later'}`},label);
        if(!snapshot.pedals[index+direction]||snapshot.pedals[index+direction].id==='tuner')button.disabled=true;
        button.addEventListener('click',()=>move(item.id,snapshot.pedals[index+direction]?.id));
        order.append(button);
      }
      if(item.id!=='tuner')order.insertBefore(dragger,order.children[1]);
      plate.append(crown,grips,art,heel);cell.append(plate,order);
      if(item.id==='wah')plate.append(cell.knobs[0].holder);
      cell.addEventListener('dragover',event=>event.preventDefault());
      cell.addEventListener('drop',event=>{event.preventDefault();move(drag,item.id);drag=null;});
      cells.append(cell);cellsById.set(item.id,cell);
    }
    refreshLoop();
    refreshTuner();
    requestAnimationFrame(redrawCables);
  }
  const observer=new ResizeObserver(redrawCables);observer.observe(tray);
  midiButton.addEventListener('click',async()=>{
    try{
      if(!navigator.requestMIDIAccess)throw new Error('Web MIDI is unavailable.');
      midi=await navigator.requestMIDIAccess({sysex:false});status.textContent=`${midi.inputs.size} MIDI input(s)`;
      const attach=()=>{for(const input of midi.inputs.values())input.onmidimessage=event=>{
        const [byte,number,value]=event.data;
        if((byte&240)!==176)return;
        const channel=byte&15;
        if(learning&&target){snapshot.midi=snapshot.midi.filter(item=>item.number!==number||item.channel!==channel);snapshot.midi.push({...target,channel,number});
          learning=false;learnButton.setAttribute('aria-pressed','false');status.textContent='Mapping assigned.';target=null;emit();return;}
        for(const item of snapshot.midi.filter(entry=>entry.channel===channel&&entry.number===number)){
          const pedal=snapshot.pedals.find(entry=>entry.id===item.id);
          if(item.knob>=0)setValue(pedal,item.knob,value/127);
          else{
            const tag=`${channel}:${number}`;
            if(value<64)pressed.delete(tag);else if(!pressed.has(tag)){pressed.add(tag);stomp(pedal);}
          }
        }
      };};
      attach();midi.onstatechange=attach;
    }catch(error){status.textContent=error.message;}
  });
  learnButton.addEventListener('click',()=>{
    if(!midi){status.textContent='Connect MIDI first.';return;}
    learning=!learning;learnButton.setAttribute('aria-pressed',learning);target=null;
    status.textContent=learning?'Choose a knob or footswitch.':'Learn off.';
  });
  saveButton.addEventListener('click',()=>{
    const blob=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)+'\n'],{type:'application/json'}));
    const link=node('a',{href:blob,download:'atelier-pedalboard.json'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(blob),1000);
  });
  loadButton.addEventListener('click',()=>file.click());
  file.addEventListener('change',async()=>{
    try{if(file.files[0]){snapshot=readPreset(JSON.parse(await file.files[0].text()),dsp.normalizePedalState);emit();draw();status.textContent='Preset loaded.';}}
    catch(error){status.textContent=error.message;}finally{file.value='';}
  });
  draw();
  const tunerTimer=setInterval(refreshTuner,100);
  return { board, chain, getState:()=>structuredClone(snapshot),
    setState(value){snapshot=readPreset(value,dsp.normalizePedalState);emit();draw();},
    setExpression(value){
      if(!Number.isFinite(value))throw new TypeError('Expression needs a finite number.');
      setValue(snapshot.pedals.find(pedal=>pedal.id==='wah'),0,value);
    },
    setWahEnabled(enabled){setActive(snapshot.pedals.find(pedal=>pedal.id==='wah'),Boolean(enabled));},
    destroy(){clearInterval(tunerTimer);observer.disconnect();input.disconnect(pitchInput);input.disconnect(chain);chain.disconnect();chain.port.onmessage=null;board.remove();if(midi)for(const input of midi.inputs.values())input.onmidimessage=null;},
  };
}
