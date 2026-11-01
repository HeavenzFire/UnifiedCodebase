'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {TaskLedger}=require('./task-ledger.cjs');
const {createOrchestratorTaskWorker}=require('./ledger-orchestrator-worker.cjs');
async function makeLedger(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-worker-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return new TaskLedger(path.join(dir,'tasks.json')).open()}
test('worker claims ledger task, calls existing orchestrator adapter, and persists receipt',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-1',payload:{prompt:'return test token',role:'verifier'},requiredCapabilities:['model.task']},{now:1000});
 let called=null;const adapter={async run(input){called=input;return {response:'HF_TEST_OK',model:'local-model',httpStatus:200,elapsedMs:4}}};
 const worker=createOrchestratorTaskWorker({ledger,adapter,workerId:'local-worker',clock:()=>1001});const result=await worker.runOnce();const saved=await ledger.get('live-task-1');
 assert.equal(result.status,'succeeded');assert.deepEqual(called,{taskId:'live-task-1',role:'verifier',prompt:'return test token'});
 assert.equal(saved.status,'succeeded');assert.equal(saved.result.response,'HF_TEST_OK');assert.equal(saved.evidence[0].ref,'orchestrator:live-task-1');
});
test('worker persists bounded retry after adapter failure and succeeds on next eligible claim',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-2',payload:{prompt:'retry safely'},maxAttempts:2},{now:1000});
 let calls=0,now=1001;const adapter={async run(){calls++;if(calls===1)throw Error('temporary 502');return {response:'recovered',httpStatus:200}}};
 const worker=createOrchestratorTaskWorker({ledger,adapter,workerId:'local-worker',retryDelayMs:50,clock:()=>now});
 const first=await worker.runOnce();assert.equal(first.status,'retry-scheduled');assert.equal(first.nextAttemptAt,1051);
 now=1050;assert.equal((await worker.runOnce()).status,'idle');
 now=1051;const second=await worker.runOnce();assert.equal(second.status,'succeeded');assert.equal((await ledger.get('live-task-2')).attempts,2);
});
test('worker records invalid task payload as a failed attempt instead of sending it to adapter',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-3',payload:{notPrompt:true},maxAttempts:1},{now:1000});
 let calls=0;const worker=createOrchestratorTaskWorker({ledger,adapter:{async run(){calls++;return {}}},workerId:'local-worker',clock:()=>1001});
 const result=await worker.runOnce();const saved=await ledger.get('live-task-3');
 assert.equal(result.status,'failed');assert.equal(calls,0);assert.match(saved.error,/non-empty prompt/);
});
