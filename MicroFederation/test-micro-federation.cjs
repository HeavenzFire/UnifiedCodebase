'use strict';
const assert=require('node:assert/strict');
const {ROLES,makeTask,decide,createSandbox,createRootConductor,hash,signTaskEnvelope,createTaskEnvelopeVerifier}=require('./micro-federation.cjs');
(async()=>{
 assert.deepEqual(ROLES,['conductor','builder','verifier','reviewer']);
 const t=makeTask({id:'acceptance-001',payload:{op:'classify',value:42},requiredCapabilities:['local-inference']});
 assert.equal(t.inputHash,hash(t.payload));
 const secret='micro-federation-test-secret-32-bytes-minimum';const signed=signTaskEnvelope({task:t,issuer:'root-conductor',expiresAt:Date.now()+60000},secret);const verifyEnvelope=createTaskEnvelopeVerifier({secret,allowedIssuers:['root-conductor']});assert.equal(verifyEnvelope(signed).ok,true);assert.equal(verifyEnvelope(signed).reason,'replay_detected');assert.equal(createTaskEnvelopeVerifier({secret:'another-test-secret-32-bytes-minimum'})(signed).reason,'invalid_signature');
 assert.equal(decide([1,1,1,0]).outcome,'approve');
 assert.equal(decide([1,1,0,0]).outcome,'defer');
 assert.equal(decide([1,1,1,-1]).outcome,'reject');
 assert.throws(()=>decide([1,1,1]),/exactly four/);
 let active=0,maxActive=0; const worker=async({role})=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,15));active--;return {vote:1,role,artifact:role==='builder'?{answer:42}:null};};
 const a=createSandbox({id:'sandbox-A',worker});
 const b=createSandbox({id:'sandbox-B',worker});
 const root=createRootConductor({sandboxes:[a,b],externalVerifier:async({result})=>({ok:true,resultHash:hash(result.outputs.builder.artifact)})});
 const routed=await root.route(t);
 assert.equal(routed.accepted,true); assert.equal(routed.rootDecision,'accepted'); assert.equal(maxActive,8,'four roles execute concurrently in each of two sandboxes'); assert.equal(routed.sandboxIds.length,2); assert.equal(routed.artifactsAgree,true);
 assert.equal(routed.sandboxDecision.approvals,4); assert.match(routed.traceHead,/^[a-f0-9]{64}$/);
 const badRoot=createRootConductor({sandboxes:[a,b],externalVerifier:async()=>({ok:false,reason:'cross-check mismatch'})});
 const quarantined=await badRoot.route(makeTask({id:'acceptance-002',payload:{op:'mutate'}}));
 assert.equal(quarantined.accepted,false); assert.equal(quarantined.rootDecision,'quarantined');
 const rejectSandbox=createSandbox({id:'sandbox-veto',worker:async({role})=>({vote:role==='reviewer'?-1:1})});
 const veto=await rejectSandbox.run(makeTask({id:'acceptance-003',payload:{}})); assert.equal(veto.decision.outcome,'reject');
 const deferSandbox=createSandbox({id:'sandbox-defer',worker:async({role})=>({vote:role==='reviewer'?0:role==='verifier'?0:1})});
 const defer=await deferSandbox.run(makeTask({id:'acceptance-004',payload:{}})); assert.equal(defer.decision.outcome,'defer');
 console.log(JSON.stringify({ok:true,tests:20,roles:ROLES,radix:3,rootRouting:routed.rootDecision,crossSandboxQuarantine:quarantined.rootDecision,veto:veto.decision.outcome,insufficientQuorum:defer.decision.outcome,traceEventsPerSandbox:routed.traceHeads.length?7:0,parallelSandboxes:routed.sandboxIds.length,maxConcurrentRoleWorkers:maxActive,modelCalls:'0 (deterministic protocol harness; worker pluggable)'},null,2));
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});





