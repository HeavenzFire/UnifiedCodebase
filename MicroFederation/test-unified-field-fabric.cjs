'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const os=require('node:os');const path=require('node:path');const fs=require('node:fs/promises');
const {TaskLedger}=require('./task-ledger.cjs');
const {createUnifiedFieldFabric}=require('./unified-field-fabric.cjs');
test('integrates durable ledger, pixel mesh, nonlinear DAG and real worker adapters',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-unified-fabric-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const ledger=await new TaskLedger(path.join(dir,'tasks.json')).open();
 const fabric=createUnifiedFieldFabric({ledger});
 fabric.mesh.register({peerId:'builder-01',roles:['builder'],capabilities:['artifact.build'],capacity:2});
 fabric.mesh.register({peerId:'verifier-01',roles:['verifier'],capabilities:['artifact.verify'],capacity:1});
 const calls=[];
 const workerAdapters={
  'builder-01':async({nodeId})=>{calls.push(nodeId);return {artifact:'built'};},
  'verifier-01':async({dependencies})=>{calls.push('verify');return {accepted:dependencies[0].result.artifact==='built'};}
 };
 // Recreate with adapters while retaining the same explicit mesh.
 const wired=createUnifiedFieldFabric({ledger,mesh:fabric.mesh,workerAdapters});
 await wired.submit({id:'fabric-task-1',workflowId:'mesh-flow',nodes:{build:{capability:'artifact.build',role:'builder'},verify:{capability:'artifact.verify',role:'verifier',dependsOn:['build']}},input:{target:'test'}});
 const result=await wired.runOne();
 assert.equal(result.status,'succeeded');assert.deepEqual(calls,['build','verify']);
 const persisted=await ledger.get('fabric-task-1');assert.equal(persisted.status,'succeeded');assert.equal(persisted.evidence[0].ref,'workflow:mesh-flow');
});
test('fails closed when a workflow node has no authorized mesh worker',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-unified-fabric-deny-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const ledger=await new TaskLedger(path.join(dir,'tasks.json')).open();const fabric=createUnifiedFieldFabric({ledger});
 await fabric.submit({id:'fabric-task-deny',workflowId:'deny-flow',nodes:{build:{capability:'artifact.build'}}});
 const result=await fabric.runOne();assert.equal(result.status,'failed');assert.match(result.error,/no available authorized mesh worker/);
 assert.equal((await ledger.get('fabric-task-deny')).status,'failed');
});

test('fabric claims only its own tasks and leaves unrelated ledger work queued',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-unified-fabric-isolation-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const ledger=await new TaskLedger(path.join(dir,'tasks.json')).open();
 await ledger.create({id:'unrelated-task',payload:{prompt:'owned by another worker'},requiredCapabilities:['model.task']});
 const fabric=createUnifiedFieldFabric({ledger,workerAdapters:{'fabric-worker':async()=>({ok:true})}});
 fabric.mesh.register({peerId:'fabric-worker',capabilities:['artifact.build']});
 const submitted=await fabric.submit({id:'fabric-task-isolated',workflowId:'fabric-isolation',nodes:{build:{capability:'artifact.build'}}});
 assert.deepEqual(submitted.requiredCapabilities,['unified-field-fabric.v1']);
 const result=await fabric.runOne();
 assert.equal(result.status,'succeeded');
 assert.equal((await ledger.get('unrelated-task')).status,'queued');
 assert.equal((await ledger.get('fabric-task-isolated')).status,'succeeded');
});
