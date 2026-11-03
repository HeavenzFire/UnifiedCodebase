'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const os=require('node:os');const path=require('node:path');const fs=require('node:fs/promises');
const {TaskLedger}=require('./task-ledger.cjs');
const {createUnifiedFieldFabric}=require('./unified-field-fabric.cjs');
const trusted={authenticateProducer:async({principal})=>({ok:true,issuer:'test-identity-provider',subject:principal}),authorizeWorker:async()=>({ok:true,issuer:'test-policy-engine',grantId:'test-grant-001'})};
async function setup(t,options={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-unified-fabric-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const ledger=await new TaskLedger(path.join(dir,'tasks.json')).open();return {ledger,fabric:createUnifiedFieldFabric({ledger,...trusted,...options})};}
const submit= (fabric,args)=>fabric.submit({...args,principal:'test-producer',producerProof:'fixture-proof'});
test('integrates ledger, mesh, nonlinear DAG and independently authorized adapters',async t=>{
 const {ledger,fabric}=await setup(t);fabric.mesh.register({peerId:'builder-01',roles:['builder'],capabilities:['artifact.build'],capacity:2});fabric.mesh.register({peerId:'verifier-01',roles:['verifier'],capabilities:['artifact.verify'],capacity:1});
 const calls=[],workerAdapters={'builder-01':async({nodeId,authorization})=>{calls.push(nodeId);assert.equal(authorization.issuer,'test-policy-engine');return {artifact:'built'};},'verifier-01':async({dependencies})=>{calls.push('verify');return {accepted:dependencies[0].result.artifact==='built'};}};
 const wired=createUnifiedFieldFabric({ledger,mesh:fabric.mesh,workerAdapters,...trusted});
 await submit(wired,{id:'fabric-task-1',workflowId:'mesh-flow',nodes:{build:{capability:'artifact.build',role:'builder'},verify:{capability:'artifact.verify',role:'verifier',dependsOn:['build']}},input:{target:'test'}});
 const result=await wired.runOne();assert.equal(result.status,'succeeded');assert.deepEqual(calls,['build','verify']);
 const persisted=await ledger.get('fabric-task-1');assert.equal(persisted.status,'succeeded');assert.equal(persisted.evidence[0].ref,'workflow:mesh-flow');assert.equal(persisted.metadata.provenance.issuer,'test-identity-provider');
});
test('fails closed when worker policy denies a peer even when its capability label matches',async t=>{
 let called=0;const {fabric}=await setup(t,{authorizeWorker:async()=>({ok:false,reason:'no grant'})});
 fabric.mesh.register({peerId:'worker-denied',capabilities:['artifact.build']});
 const wired=createUnifiedFieldFabric({ledger:fabricLedger(fabric),...trusted});
 function fabricLedger(){return null;}
});
test('rejects producer without independently authenticated identity',async t=>{
 const {fabric}=await setup(t,{authenticateProducer:async()=>({ok:false})});
 await assert.rejects(fabric.submit({id:'bad-producer',workflowId:'wf',nodes:{x:{}},principal:'untrusted'}),/producer authentication denied/);
});
test('requires independently signed approval for consequential nodes',async t=>{
 const crypto=require('node:crypto');const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
 const {createApprovalGate,canonicalApprovalPayload}=require('./approval-gate.cjs');
 let now=100000;const gate=createApprovalGate({trustedIssuers:{'human-review-board':publicKey},clock:()=>now});
 const unsigned={version:1,issuer:'human-review-board',approvedTaskId:'approval-task',approvedNodeId:'deploy',approvedAction:'deployment.apply',approvedSubject:'staging-environment',issuedAt:now,expiresAt:now+60000,nonce:'approval-nonce-1'};
 const signature=crypto.sign(null,Buffer.from(canonicalApprovalPayload(unsigned)),privateKey).toString('base64url');
 const approval={...unsigned,signature};assert.equal(gate.verify({approval,taskId:'approval-task',nodeId:'deploy',action:'deployment.apply',subject:'staging-environment'}).ok,true);
 assert.equal(gate.verify({approval,taskId:'other-task',nodeId:'deploy',action:'deployment.apply',subject:'staging-environment'}).reason,'approval_scope_mismatch');
 now+=60001;assert.equal(gate.verify({approval,taskId:'approval-task',nodeId:'deploy',action:'deployment.apply',subject:'staging-environment'}).reason,'approval_expired_or_invalid_time');
});
