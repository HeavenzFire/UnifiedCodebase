'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EngineeringControlPlane,validateWorkItem,TRANSITIONS}=require('./engineering-control-plane.cjs');
function setup(overrides={}){
 const events=[],calls=[];
 const adapters={
 inventory:{async list(){return [{id:'repo-a',name:'repo-a'}];}},
 scanner:{async scan(){return [{id:'BUG-1',kind:'defect',title:'Broken route',targets:['repo-a'],acceptanceCriteria:['regression test passes']},{id:'FEAT-1',kind:'feature',title:'Missing export feature',targets:['repo-a'],acceptanceCriteria:['export exists','round-trip test passes']}];}},
 triager:{async triage(){return {disposition:'actionable'};}},
 planner:{async plan(item){return {steps:['implement '+item.title],testCommands:['npm test']};}},
 implementer:{async implement(item){return {applied:true,workspaceId:'isolated-'+item.id,changedFiles:['src/index.js']};}},
 tester:{async test(){return {passed:true,commands:['npm test'],evidence:['test output sha256:abc']};}},
 verifier:{async verify(item){calls.push(item.verificationMode||'code');return {passed:true,evidence:['independent review sha256:def']};}},
 ledger:{async append(id,state,data){events.push({id,state,data});}}
 };
 Object.assign(adapters,overrides);
 return {engine:new EngineeringControlPlane(adapters),events,calls};
}
test('validates feature specs require targets and acceptance criteria',()=>{
 assert.throws(()=>validateWorkItem({id:'x',kind:'feature',title:'Missing criteria',targets:['repo']}),/acceptance criteria/);
 assert.throws(()=>validateWorkItem({id:'x',kind:'defect',title:'No target',acceptanceCriteria:['works'],targets:[]}),/target/);
});
test('control plane repairs defects and instantiates features only after acceptance verification',async()=>{
 const {engine,events,calls}=setup(); const r=await engine.cycle();
 assert.equal(r.targets,1); assert.equal(r.discovered,2); assert.equal(r.verified,2); assert.equal(r.instantiated,1); assert.equal(r.blocked,0);
 assert.deepEqual(calls,['code','code','feature_acceptance']);
 assert.ok(events.some(x=>x.id==='FEAT-1'&&x.state==='instantiated'));
 assert.ok(!events.some(x=>x.id==='BUG-1'&&x.state==='instantiated'));
});
test('does not claim completion when regression tests fail',async()=>{
 const {engine,events}=setup({tester:{async test(){return {passed:false,evidence:[]};}}});
 const r=await engine.cycle(); assert.equal(r.instantiated,0); assert.equal(r.blocked,2);
 assert.ok(events.every(x=>x.state!=='verified'&&x.state!=='instantiated'));
});
test('blocks non-actionable items without implementation',async()=>{
 let writes=0;
 const {engine}=setup({triager:{async triage(){return {disposition:'needs_human',reason:'repro unavailable'};}},implementer:{async implement(){writes++;}}});
 const r=await engine.cycle(); assert.equal(r.blocked,2); assert.equal(writes,0);
});
test('rejects concurrent overlapping control-plane cycles',async()=>{
 let release; const wait=new Promise(r=>release=r);
 const {engine}=setup({inventory:{async list(){await wait;return [];}}});
 const first=engine.cycle(); await new Promise(r=>setImmediate(r));
 await assert.rejects(engine.cycle(),/already running/); release(); await first;
});
test('state transitions are explicit and terminal states cannot silently advance',()=>{
 assert.deepEqual(TRANSITIONS.verified,['instantiated','blocked']); assert.deepEqual(TRANSITIONS.instantiated,[]);
});
