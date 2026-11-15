const key = /^[a-z][a-z0-9-]{0,32}$/;
export const format = 'atelier-pedalboard/1';
export function readPreset(data, normalize) {
  if (data?.format !== format) throw new Error('Expected an Atelier pedalboard preset.');
  const pedals = normalize(data.pedals);
  const controlCounts = new Map(pedals.map(pedal=>[pedal.id,pedal.controls.length]));
  const midi = (Array.isArray(data.midi) ? data.midi : []).slice(0,64).filter(item=>item&&key.test(item.id)&&controlCounts.has(item.id)&&
    Number.isInteger(item.knob)&&item.knob>=-1&&item.knob<controlCounts.get(item.id)&&Number.isInteger(item.number)&&item.number>=0&&item.number<=127&&
    Number.isInteger(item.channel)&&item.channel>=0&&item.channel<=15
  ).map(({id,knob,channel,number})=>({id,knob,channel,number}));
  return {format,pedals,midi};
}
export function formatControl(id,index,value) {
  return id==='eleven'&&index===0 ? (Math.round(value*110)/10).toFixed(1) : String(Math.round(value*100));
}
