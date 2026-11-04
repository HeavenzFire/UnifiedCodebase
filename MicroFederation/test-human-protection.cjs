'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path'),fs=require('node:fs/promises');
const {TaskLedger}=require('./task-ledger.cjs');
async function makeLedger(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-human-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return new TaskLedger(path.join(dir,'ledger.json')).open();}
test('rejects nested credential-shaped fields before persistence',async t=>{
 const ledger=await makeLedger(t);
 await assert.rejects(ledger.create({id:'nested-secret',payload:{profile:{provider:{apiKey:'must-not-persist'}}}}),/prohibited secret-like field/);
 await assert.rejects(ledger.create({id:'nested-token',payload:{nested:[{refresh_token:'must-not-persist'}]}}),/prohibited secret-like field/);
});
test('enforces payload, metadata and result byte bounds',async t=>{
 const ledger=await makeLedger(t);
 await assert.rejects(ledger.create({id:'oversized-payload',payload:{data:'x'.repeat(270*1024)}}),/byte limit/);
 await assert.rejects(ledger.create({id:'oversized-metadata',payload:{ok:true},metadata:{data:'x'.repeat(40*1024)}}),/byte limit/);
 await ledger.create({id:'bounded-result',payload:{ok:true}});await ledger.claimNext('worker');await ledger.start('bounded-result','worker');
 await assert.rejects(ledger.complete('bounded-result','worker',{data:'x'.repeat(270*1024)}),/byte limit/);
});
test('renews only the live lease owned by the running worker',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'lease-task',payload:{ok:true}},{now:1000});
 await ledger.claimNext('worker-a',{now:1000,leaseMs:5000});await ledger.start('lease-task','worker-a',{now:1001});
 const renewed=await ledger.renewLease('lease-task','worker-a',{now:2000,leaseMs:5000});assert.equal(renewed.leaseUntil,7000);
 await assert.rejects(ledger.renewLease('lease-task','worker-b',{now:2001,leaseMs:5000}),/not running under this worker/);
 await assert.rejects(ledger.renewLease('lease-task','worker-a',{now:7000,leaseMs:5000}),/lease has expired/);
});

test('rejects attempts to self-assign the fabric routing capability without a trusted verifier',async t=>{
 const ledger=await makeLedger(t);
 await assert.rejects(ledger.create({id:'self-authorized',payload:{task:'run'},requiredCapabilities:['unified-field-fabric.v1']}),/trusted task producer verifier is required/);
});


test('expired lease exhaustion is swept regardless of claimant capability filter',async t=>{
 const ledger=await makeLedger(t);
 await ledger.create({id:'expired-other-capability',payload:{ok:true},requiredCapabilities:['capability.alpha'],maxAttempts:1},{now:1000});
 await ledger.claimNext('worker-alpha',{now:1000,leaseMs:1000,requiredCapabilities:['capability.alpha']});
 assert.equal(await ledger.claimNext('worker-beta',{now:2000,leaseMs:1000,requiredCapabilities:['capability.beta']}),null);
 const task=await ledger.get('expired-other-capability');
 assert.equal(task.status,'failed');
 assert.match(task.error,/lease expired/);
});

test('persists bounded structured failure evidence across ledger restart',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-failure-trace-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'ledger.json');
 const ledger=await new TaskLedger(file).open();
 await ledger.create({id:'failure-trace',payload:{ok:true}},{now:1000});
 await ledger.claimNext('worker-a',{now:1000,leaseMs:5000});
 await ledger.start('failure-trace','worker-a',{now:1001});
 const trace={schema:'heavenzfire.workflow-failure.v1',workflowId:'wf-failure',nodeStates:{build:{status:'succeeded'},verify:{status:'failed',error:'counterexample'}},events:[{seq:1,type:'node.failed'}]};
 const failed=await ledger.fail('failure-trace','worker-a','workflow node failed',{now:1002,retryable:false,failureResult:trace});
 assert.deepEqual(failed.result,trace);
 const restored=await new TaskLedger(file).open();
 assert.deepEqual((await restored.get('failure-trace')).result,trace);
});


test('AEGIS bridge explicitly emits UTF-8 without a byte-order mark',async()=>{
 const bridge=await fs.readFile(path.join(__dirname,'..','UnifiedField','Bridge','aegis-powershell-bridge.cjs'),'utf8');
 assert.match(bridge,/\\[Console\\]::OutputEncoding = \\[System\\.Text\\.UTF8Encoding\\]::new\\(\\$false\\)/);
 assert.match(bridge,/\\$OutputEncoding = \\[Console\\]::OutputEncoding/);
});
