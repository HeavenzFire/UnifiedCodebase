'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createNonlinearWorkflow}=require('./nonlinear-workflow.cjs');
test('fans out independent branches and joins their results',async()=>{
 const w=createNonlinearWorkflow({maxConcurrent:3});let active=0,peak=0;
 const r=await w.run({workflowId:'wf-1',input:{x:2},nodes:{a:{},b:{},c:{dependsOn:['a','b']}},execute:async({nodeId,dependencies})=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return nodeId==='c'?dependencies.length:nodeId;}});
 assert.equal(r.status,'succeeded');assert.equal(r.outputs.c,2);assert.equal(peak,2);assert.equal(r.summary.succeeded,3);
});
test('evaluates branch conditions and skips downstream branch cleanly',async()=>{
 const w=createNonlinearWorkflow();const calls=[];
 const r=await w.run({workflowId:'wf-branch',nodes:{gate:{},left:{dependsOn:['gate'],when:'left'},right:{dependsOn:['gate'],when:'right'},join:{dependsOn:['left','right']}},execute:async({nodeId})=>{calls.push(nodeId);return nodeId;},chooseBranch:({expression})=>expression==='left'});
 assert.deepEqual(calls,['gate','left','join']);assert.equal(r.nodeStates.right.status,'skipped');assert.equal(r.status,'succeeded');
});
test('detects dependency cycles before calling workers and contains failures',async()=>{
 const w=createNonlinearWorkflow();let calls=0;
 await assert.rejects(w.run({workflowId:'cycle',nodes:{a:{dependsOn:['b']},b:{dependsOn:['a']}},execute:async()=>{calls++;}}),/cycle/);assert.equal(calls,0);
 const r=await w.run({workflowId:'fail',nodes:{a:{},b:{dependsOn:['a']}},execute:async()=>{throw Error('controlled failure');}});
 assert.equal(r.status,'failed');assert.equal(r.nodeStates.b.status,'pending');
});
