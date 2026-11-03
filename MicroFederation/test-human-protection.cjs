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
