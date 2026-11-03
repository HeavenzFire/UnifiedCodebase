'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const os=require('node:os');const path=require('node:path');const fs=require('node:fs/promises');
const {TaskLedger}=require('./task-ledger.cjs');
const {createUnifiedFieldFabric}=require('./unified-field-fabric.cjs');
const {createApprovalGate,canonicalApprovalPayload}=require('./approval-gate.cjs');
const workerPolicy=async({taskId,nodeId,capability,peerId})=>({ok:true,issuer:'test-policy-engine',grantId:'test-grant-001',taskId,nodeId,capability,peerId,expiresAt:Date.now()+60000});
async function setup(t,{producerVerifier=null,authorizeWorker=workerPolicy,approvalGate=null,workerAdapters={}}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-unified-fabric-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const authenticateProducer=producerVerifier|| (async({principal})=>({ok:true,issuer:'test-identity-provider',subject:principal}));
 const ledger=await new TaskLedger(path.join(dir,'tasks.json'),{authenticateProducer}).open();
 const fabric=createUnifiedFieldFabric({ledger,authorizeWorker,approvalGate,workerAdapters});return {ledger,fabric};
}
const submit=(fabric,args)=>fabric.submit({...args,principal:'test-producer',producerProof:'fixture-proof'});
test('integrates ledger, mesh, nonlinear DAG and independently authorized adapters',async t=>{
 const {ledger,fabric}=await setup(t);fabric.mesh.register({peerId:'builder-01',roles:['builder'],capabilities:['artifact.build'],capacity:2});fabric.mesh.register({peerId:'verifier-01',roles:['verifier'],capabilities:['artifact.verify'],capacity:1});
 const calls=[],workerAdapters={'builder-01':async({nodeId,authorization})=>{calls.push(nodeId);assert.equal(authorization.issuer,'test-policy-engine');return {artifact:'built'};},'verifier-01':async({dependencies})=>{calls.push('verify');return {accepted:dependencies[0].result.artifact==='built'};}};
 const wired=createUnifiedFieldFabric({ledger,mesh:fabric.mesh,workerAdapters,authorizeWorker:workerPolicy});
 await submit(wired,{id:'fabric-task-1',workflowId:'mesh-flow',nodes:{build:{capability:'artifact.build',role:'builder'},verify:{capability:'artifact.verify',role:'verifier',dependsOn:['build']}},input:{target:'test'}});
 const result=await wired.runOne();assert.equal(result.status,'succeeded');assert.deepEqual(calls,['build','verify']);
 const persisted=await ledger.get('fabric-task-1');assert.equal(persisted.status,'succeeded');assert.equal(persisted.evidence[0].ref,'workflow:mesh-flow');assert.equal(persisted.metadata.provenance.issuer,'test-identity-provider');
});
test('fails closed when worker policy denies a peer despite a matching capability label',async t=>{
 let called=0;const deny=async()=>({ok:false,reason:'no grant'});const {ledger,fabric}=await setup(t,{authorizeWorker:deny});
 fabric.mesh.register({peerId:'worker-denied',capabilities:['artifact.build']});
 const wired=createUnifiedFieldFabric({ledger,mesh:fabric.mesh,workerAdapters:{'worker-denied':async()=>{called++;return {ok:true};}},authorizeWorker:deny});
 await submit(wired,{id:'denied-task',workflowId:'denied-flow',nodes:{build:{capability:'artifact.build'}}});
 const result=await wired.runOne();assert.equal(result.status,'failed');assert.match(result.error,/no independently authorized worker/);assert.equal(called,0);
});
test('ledger rejects forged fabric queue tags without producer proof',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-no-producer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const ledger=await new TaskLedger(path.join(dir,'tasks.json')).open();
 await assert.rejects(ledger.create({id:'forged',payload:{workflowId:'wf'},requiredCapabilities:['unified-field-fabric.v1']}),/trusted task producer verifier is required/);
});
test('rejects producer when configured identity verifier denies the principal',async t=>{
 const {fabric}=await setup(t,{producerVerifier:async()=>({ok:false})});
 await assert.rejects(fabric.submit({id:'bad-producer',workflowId:'wf',nodes:{x:{}},principal:'untrusted'}),/producer authentication denied/);
});
test('requires independently signed approval for consequential nodes and rejects replay',async t=>{
 const crypto=require('node:crypto');const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');let now=100000;
 const gate=createApprovalGate({trustedIssuers:{'human-review-board':publicKey},clock:()=>now});
 const unsigned={version:1,issuer:'human-review-board',approvedTaskId:'approval-task',approvedNodeId:'deploy',approvedAction:'deployment.apply',approvedSubject:'staging-environment',issuedAt:now,expiresAt:now+60000,nonce:'approval-nonce-1'};
 const approval={...unsigned,signature:crypto.sign(null,Buffer.from(canonicalApprovalPayload(unsigned)),privateKey).toString('base64url')};
 assert.equal(gate.verify({approval,taskId:'approval-task',nodeId:'deploy',action:'deployment.apply',subject:'staging-environment'}).ok,true);
 assert.equal(gate.verify({approval,taskId:'approval-task',nodeId:'deploy',action:'deployment.apply',subject:'staging-environment'}).reason,'approval_replayed');
 assert.equal(gate.verify({approval,taskId:'other-task',nodeId:'deploy',action:'deployment.apply',subject:'staging-environment'}).reason,'approval_scope_mismatch');
});
test('fabric denies consequential execution without valid independent approval',async t=>{
 const crypto=require('node:crypto');const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
 const gate=createApprovalGate({trustedIssuers:{'human-review-board':publicKey}});
 const {ledger,fabric}=await setup(t,{approvalGate:gate});
 let calls=0,grantCalls=0;fabric.mesh.register({peerId:'deploy-worker',capabilities:['deployment.apply']});
 const countPolicy=async args=>{grantCalls++;return workerPolicy(args);};
 const wired=createUnifiedFieldFabric({ledger,mesh:fabric.mesh,workerAdapters:{'deploy-worker':async()=>{calls++;return {ok:true};}},authorizeWorker:countPolicy,approvalGate:gate});
 await submit(wired,{id:'approval-required-task',workflowId:'approval-flow',nodes:{deploy:{capability:'deployment.apply',approvalRequired:true}}});
 const result=await wired.runOne();assert.equal(result.status,'failed');assert.match(result.error,/approval_missing/);assert.equal(calls,0);assert.equal(grantCalls,0);
});
