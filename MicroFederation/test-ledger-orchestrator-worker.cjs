'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {TaskLedger}=require('./task-ledger.cjs');
const {createOrchestratorTaskWorker}=require('./ledger-orchestrator-worker.cjs');
async function makeLedger(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-ledger-worker-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return new TaskLedger(path.join(dir,'tasks.json')).open()}

test('worker claims ledger task, passes a cooperative signal, and persists receipt',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-1',payload:{prompt:'return test token',role:'verifier'},requiredCapabilities:['model.task']},{now:1000});
 let called=null;const adapter={async run(input){called=input;return {response:'HF_TEST_OK',model:'local-model',httpStatus:200,elapsedMs:4}}};
 const worker=createOrchestratorTaskWorker({ledger,adapter,workerId:'local-worker',clock:()=>1001});const result=await worker.runOnce();const saved=await ledger.get('live-task-1');
 assert.equal(result.status,'succeeded');
 assert.equal(called.taskId,'live-task-1');assert.equal(called.role,'verifier');assert.equal(called.prompt,'return test token');
 assert.ok(called.signal instanceof AbortSignal);assert.equal(called.signal.aborted,false);
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

test('timeout aborts the adapter signal and is terminal to prevent an unsafe automatic retry',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-4',payload:{prompt:'hang safely'},maxAttempts:2},{now:1000});
 let receivedSignal=null;
 const worker=createOrchestratorTaskWorker({ledger,adapter:{run({signal}){receivedSignal=signal;return new Promise(()=>{})}},workerId:'local-worker',leaseMs:1000,retryDelayMs:10,clock:()=>1001});
 const result=await worker.runOnce();const saved=await ledger.get('live-task-4');
 assert.equal(result.status,'timed-out');assert.equal(result.executionMayContinue,true);
 assert.ok(receivedSignal instanceof AbortSignal);assert.equal(receivedSignal.aborted,true);
 assert.equal(saved.status,'failed');assert.equal(saved.attempts,1);
 assert.equal((await worker.runOnce()).status,'idle');
});

test('caller cancellation aborts adapter signal and records a terminal cancelled task',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-5',payload:{prompt:'stop when asked'},maxAttempts:3},{now:1000});
 const controller=new AbortController();let startedResolve;const started=new Promise(resolve=>{startedResolve=resolve});let receivedSignal=null;
 const adapter={run({signal}){receivedSignal=signal;startedResolve();return new Promise(()=>{})}};
 const worker=createOrchestratorTaskWorker({ledger,adapter,workerId:'local-worker',clock:()=>1001});
 const running=worker.runOnce({signal:controller.signal});
 await started;controller.abort(new Error('operator requested stop'));
 const result=await running;const saved=await ledger.get('live-task-5');
 assert.equal(result.status,'cancelled');assert.equal(result.executionMayContinue,true);
 assert.equal(receivedSignal.aborted,true);assert.equal(saved.status,'cancelled');assert.equal(saved.attempts,1);
 assert.equal(saved.events.at(-1).type,'task.cancelled');assert.match(saved.events.at(-1).reason,/operator requested stop/);
});

test('cancellation during task start records cancelled before any adapter invocation',async t=>{
 const realLedger=await makeLedger(t);await realLedger.create({id:'live-task-6',payload:{prompt:'cancel before provider call'}},{now:1000});
 let enteredStartResolve,releaseStart;const enteredStart=new Promise(resolve=>{enteredStartResolve=resolve});const startGate=new Promise(resolve=>{releaseStart=resolve});
 const ledger={
  claimNext:(...args)=>realLedger.claimNext(...args),
  start:async(...args)=>{enteredStartResolve();await startGate;return realLedger.start(...args)},
  complete:(...args)=>realLedger.complete(...args),
  fail:(...args)=>realLedger.fail(...args),
  cancel:(...args)=>realLedger.cancel(...args),
  get:(...args)=>realLedger.get(...args)
 };
 const controller=new AbortController();let adapterCalls=0;
 const worker=createOrchestratorTaskWorker({ledger,adapter:{async run(){adapterCalls++;return {ok:true}}},workerId:'local-worker',clock:()=>1001});
 const running=worker.runOnce({signal:controller.signal});
 await enteredStart;controller.abort('cancel before adapter');releaseStart();
 const result=await running;const saved=await realLedger.get('live-task-6');
 assert.equal(result.status,'cancelled');assert.equal(result.executionMayContinue,false);
 assert.equal(adapterCalls,0);assert.equal(saved.status,'cancelled');
});

test('pre-aborted caller signal leaves queued work untouched',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-7',payload:{prompt:'do not start'}},{now:1000});
 const controller=new AbortController();controller.abort('stop before dispatch');
 const worker=createOrchestratorTaskWorker({ledger,adapter:{async run(){throw Error('must not run')}},workerId:'local-worker',clock:()=>1001});
 const result=await worker.runOnce({signal:controller.signal});const saved=await ledger.get('live-task-7');
 assert.equal(result.status,'cancelled-before-claim');assert.equal(saved.status,'queued');assert.equal(saved.attempts,0);
});

test('worker reports lease-lost when ledger rejects a late failure update',async()=>{
 let now=1001;
 const ledger={
  async claimNext(){return {id:'late-task',payload:{prompt:'expire'},owner:'worker',attempts:1}},
  async start(){return {status:'running'}},
  async complete(){throw Error('should not complete')},
  async fail(){throw Error('task lease has expired')},
  async cancel(){throw Error('task lease has expired')},
  async get(){return null}
 };
 const adapter={async run(){now=3000;throw Error('adapter failed after lease')}};
 const worker=createOrchestratorTaskWorker({ledger,adapter,workerId:'worker',leaseMs:1000,clock:()=>now});
 const result=await worker.runOnce({now:1001});assert.equal(result.status,'lease-lost');assert.match(result.ledgerError,/lease has expired/);
});

test('rejects a malformed cancellation signal before claiming work',async t=>{
 const ledger=await makeLedger(t);await ledger.create({id:'live-task-8',payload:{prompt:'validate signal'}},{now:1000});
 const worker=createOrchestratorTaskWorker({ledger,adapter:{async run(){return {ok:true}}},workerId:'local-worker',clock:()=>1001});
 await assert.rejects(worker.runOnce({signal:{aborted:false}}),/AbortSignal/);
 assert.equal((await ledger.get('live-task-8')).status,'queued');
});
