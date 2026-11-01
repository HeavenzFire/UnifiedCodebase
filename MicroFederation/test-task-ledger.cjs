'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {TaskLedger}=require('./task-ledger.cjs');
async function tempFile(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-task-ledger-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return path.join(dir,'tasks.json')}
const task=(id,extra={})=>({id,payload:{prompt:'verify',acceptance:{type:'number-equals',expected:2}},requiredCapabilities:['model.task'],...extra});

test('persists task state and results across restart',async t=>{
 const file=await tempFile(t),first=await new TaskLedger(file).open();await first.create(task('task-1'),{now:10000});
 const claim=await first.claimNext('worker-a',{now:10001,leaseMs:5000});await first.start('task-1','worker-a',{now:10002});
 await first.complete('task-1','worker-a',{answer:2},{now:10003,evidenceRef:'run:42'});
 const restored=await new TaskLedger(file).open().then(x=>x.get('task-1'));
 assert.equal(claim.status,'claimed');assert.equal(restored.status,'succeeded');assert.deepEqual(restored.result,{answer:2});assert.equal(restored.evidence[0].ref,'run:42');
});
test('idempotency key returns same task for identical input and rejects conflicting reuse',async t=>{
 const ledger=await new TaskLedger(await tempFile(t)).open();const created=await ledger.create(task('task-2',{idempotencyKey:'request-2'}),{now:1000});
 assert.equal((await ledger.create(task('task-2',{idempotencyKey:'request-2'}),{now:1001})).id,created.id);
 await assert.rejects(ledger.create(task('task-3',{idempotencyKey:'request-2'})),/already exists/);
});
test('claims serialize and worker ownership is enforced',async t=>{
 const ledger=await new TaskLedger(await tempFile(t)).open();await ledger.create(task('task-3'),{now:1000});
 const [a,b]=await Promise.all([ledger.claimNext('worker-a'),ledger.claimNext('worker-b')]);assert.equal([a,b].filter(Boolean).length,1);
 const owner=a||b,other=owner.owner==='worker-a'?'worker-b':'worker-a';
 await assert.rejects(ledger.start('task-3',other),/not claimed/);await ledger.start('task-3',owner.owner);
 await assert.rejects(ledger.complete('task-3',other,{ok:true}),/not running/);
});
test('retry metadata is bounded and exhausted retries become terminal failures',async t=>{
 const ledger=await new TaskLedger(await tempFile(t)).open();await ledger.create(task('task-4',{maxAttempts:2}),{now:900});
 await ledger.claimNext('worker-a');await ledger.start('task-4','worker-a');
 let failed=await ledger.fail('task-4','worker-a','temporary backend failure',{retryable:true,retryDelayMs:10,now:1000});
 assert.equal(failed.status,'queued');assert.equal(failed.nextAttemptAt,1010);
 await ledger.claimNext('worker-b',{now:1010});await ledger.start('task-4','worker-b',{now:1011});
 failed=await ledger.fail('task-4','worker-b','second failure',{retryable:true,now:1012});
 assert.equal(failed.status,'failed');assert.equal(failed.attempts,2);
});
test('expired worker leases can be reclaimed after restart',async t=>{
 const file=await tempFile(t),ledger=await new TaskLedger(file).open();await ledger.create(task('task-5'),{now:1000});
 await ledger.claimNext('worker-a',{now:1000,leaseMs:1000});
 const restarted=await new TaskLedger(file).open(),reclaimed=await restarted.claimNext('worker-b',{now:2000,leaseMs:1000});
 assert.equal(reclaimed.owner,'worker-b');assert.equal(reclaimed.attempts,2);assert.equal(reclaimed.events.at(-1).type,'task.lease_reclaimed');
});
test('expired lease at retry limit becomes failed rather than exceeding maxAttempts',async t=>{
 const file=await tempFile(t),ledger=await new TaskLedger(file).open();await ledger.create(task('task-6',{maxAttempts:1}),{now:1000});
 await ledger.claimNext('worker-a',{now:1000,leaseMs:1000});const restarted=await new TaskLedger(file).open();
 assert.equal(await restarted.claimNext('worker-b',{now:2000,leaseMs:1000}),null);
 const record=await restarted.get('task-6');assert.equal(record.status,'failed');assert.equal(record.attempts,1);
});
test('cancellation and evidence are auditable and terminal tasks cannot be cancelled twice',async t=>{
 const ledger=await new TaskLedger(await tempFile(t)).open();await ledger.create(task('task-7'));
 await ledger.addEvidence('task-7','commit:abc');const cancelled=await ledger.cancel('task-7','operator requested stop');
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.evidence[0].ref,'commit:abc');
 await assert.rejects(ledger.cancel('task-7','again'),/terminal task/);
});
test('rejects undeclared secret fields, invalid retries, and corrupted stores',async t=>{
 const file=await tempFile(t),ledger=await new TaskLedger(file).open();
 await assert.rejects(ledger.create(task('bad-1',{apiKey:'never-persist'})),/unsupported task field/);
 await assert.rejects(ledger.create(task('bad-2',{maxAttempts:99})),/maxAttempts/);
 await fs.writeFile(file,JSON.stringify({schema:'wrong',tasks:[]}));await assert.rejects(new TaskLedger(file).open(),/schema is invalid/);
});
test('stats report queued and cancelled states',async t=>{
 const ledger=await new TaskLedger(await tempFile(t)).open();await ledger.create(task('task-8'));await ledger.create(task('task-9'));
 await ledger.cancel('task-9','not needed');const stats=await ledger.stats();
 assert.equal(stats.total,2);assert.equal(stats.byStatus.queued,1);assert.equal(stats.byStatus.cancelled,1);
});
