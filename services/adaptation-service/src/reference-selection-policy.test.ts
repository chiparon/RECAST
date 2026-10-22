import {test} from 'vitest';import assert from 'node:assert/strict';import {chooseImplementationReferences as choose} from './reference-selection-policy';
const p=(id:string)=>({id,reason:'implementation',evidence:'source',incrementalValue:'mechanism'});
test('three alternatives for one mechanism keep only the primary',()=>assert.deepEqual(choose(['a','b','c'].map(p),['a','b','c'].map(id=>({id,score:.9,covers:[0]}))).selected.map(x=>x.id),['a']));
test('a low-scored wrapper cannot add a new claimed label',()=>assert.deepEqual(choose(['a','b'].map(p),[{id:'a',score:.9,covers:[0]},{id:'b',score:.3,covers:[1]}]).selected.map(x=>x.id),['a']));
test('credible independent mechanism survives and subsequent overlap does not',()=>assert.deepEqual(choose(['a','b','c'].map(p),[{id:'a',score:.8,covers:[0]},{id:'b',score:.6,covers:[1]},{id:'c',score:.8,covers:[0,1]}]).selected.map(x=>x.id),['a','b']));
test('a limited primary remains useful without fabricating full coverage',()=>assert.equal(choose([p('a')],[{id:'a',score:.3,covers:[]}]).selected.length,1));
test('invented and repeated IDs fail rather than reaching downstream',()=>{assert.throws(()=>choose([p('x')],[{id:'a',score:1,covers:[0]}]));assert.throws(()=>choose([p('a'),p('a')],[{id:'a',score:1,covers:[0]}]));});

import {parseReferenceSelection} from './reference-selection-policy';
test('selection carries evidence and gaps rather than score rows into implementation',()=>{
 const value={responsibilities:['parse'],candidates:[{id:'a',score:.9,covers:[0]}],selected:[p('a')],missingResponsibilities:['storage']};
 assert.equal(parseReferenceSelection(value,['a']).selected[0].evidence,'source');
 assert.throws(()=>parseReferenceSelection({...value,selected:[{id:'a',score:.9,covers:[0]}]},['a']));
 assert.throws(()=>parseReferenceSelection({...value,selected:[{...p('a'),evidence:''}]},['a']));
});
