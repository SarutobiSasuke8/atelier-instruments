import assert from 'node:assert/strict';
import test from 'node:test';
import { format, formatControl, readPreset } from '../../../shared/pedalboard/preset.js';
test('presets preserve order and valid MIDI mapping and reject an unrelated schema',()=>{
  const pedals=[{id:'eleven',bypass:false,controls:[1,.5,.2]},{id:'doom',bypass:true,controls:[.1,.4,.7]}];
  const csv={format,pedals,midi:[{id:'eleven',knob:0,channel:0,number:20},{id:'doom',knob:-1,channel:1,number:64},{id:'unknown',knob:0,channel:0,number:20}]};
  const saved=readPreset(JSON.parse(JSON.stringify(csv)),x=>x);
  assert.deepEqual(saved.pedals,pedals);
  assert.deepEqual(saved.midi,csv.midi.slice(0,2));
  assert.equal(formatControl('eleven',0,1),'11.0');
  assert.throws(()=>readPreset({},x=>x),/Expected/);
});

test('a six-control EQ keeps MIDI mappings through its boost knob',()=>{
  const pedals=[{id:'eq',bypass:false,controls:[.5,.5,.5,.5,.5,.3]}];
  const boost={id:'eq',knob:5,channel:1,number:42};
  const midi=[boost,{...boost,knob:6}];
  assert.deepEqual(readPreset({format,pedals,midi},x=>x).midi,[boost]);
});
