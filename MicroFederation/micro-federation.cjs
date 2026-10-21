'use strict';
// HeavenzFire MicroFederation v0.1: deterministic classical orchestration prototype.
// Four logical roles per sandbox; pluggable workers; ternary vote semantics.
const crypto = require('node:crypto');
const ROLES = Object.freeze(['conductor','builder','verifier','reviewer']);
const VOTE = Object.freeze({REJECT:-1,ABSTAIN:0,APPROVE:1});
function canonical(v){ if(Array.isArray(v))return '['+v.map(canonical).join(',')+']'; if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'; return JSON.stringify(v); }
function hash(v){return crypto.createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');}
function makeTask({id,parentId=null,kind='work',payload,requiredCapabilities=[],deadlineMs=30000}){
 if(!/^[A-Za-z0-9._:-]{1,128}$/.test(id||''))throw Error('invalid task id');
 if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>3600000)throw Error('deadlineMs must be 1..3600000');
 const body={protocol:'hf-microtask/1',id,parentId,kind,payload,requiredCapabilities:[...new Set(requiredCapabilities)].sort(),deadlineMs,inputHash:hash(payload)};
 return Object.freeze({...body,envelopeHash:hash(body)});
}
function decide(votes,{quorum=3}={}){
 if(!Array.isArray(votes)||votes.length!==4)throw Error('exactly four role votes required');
 if(!Number.isInteger(quorum)||quorum<2||quorum>4)throw Error('quorum must be 2..4');
 const valid=votes.filter(v=>v===-1||v===0||v===1); if(valid.length!==4)throw Error('votes must be ternary: -1, 0, +1');
 const approvals=valid.filter(v=>v===1).length,rejections=valid.filter(v=>v===-1).length,abstentions=valid.filter(v=>v===0).length;
 // Veto wins; approval requires quorum; otherwise unresolved, never silently accepted.
 const outcome=rejections>0?'reject':approvals>=quorum?'approve':'defer';
 return {outcome,approvals,rejections,abstentions,quorum,radix:3};
}
function signTaskEnvelope({task,issuer,issuedAt=Date.now(),expiresAt,nonce=crypto.randomBytes(16).toString('hex')},secret){
 if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw Error('signing secret must be at least 32 bytes');
 if(!task||!issuer||!Number.isFinite(expiresAt)||expiresAt<=issuedAt)throw Error('task, issuer and valid expiry are required');
 const body={protocol:'hf-signed-envelope/1',task,issuer,issuedAt,expiresAt,nonce};
 const signature=crypto.createHmac('sha256',secret).update(canonical(body)).digest('hex');
 return Object.freeze({...body,signature});
}
function createTaskEnvelopeVerifier({secret,allowedIssuers,now=()=>Date.now(),maxTtlMs=300000}){
 if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw Error('verification secret must be at least 32 bytes');
 const seen=new Set();
 return function verify(envelope){
  if(!envelope||envelope.protocol!=='hf-signed-envelope/1'||!envelope.task||typeof envelope.issuer!=='string'||typeof envelope.nonce!=='string'||typeof envelope.signature!=='string')return {ok:false,reason:'malformed_envelope'};
  const t=now();if(!Number.isFinite(envelope.issuedAt)||!Number.isFinite(envelope.expiresAt)||envelope.issuedAt>t+30000||envelope.expiresAt<=t||envelope.expiresAt-envelope.issuedAt>maxTtlMs)return {ok:false,reason:'expired_or_invalid_lifetime'};
  if(allowedIssuers&&!allowedIssuers.includes(envelope.issuer))return {ok:false,reason:'issuer_not_allowed'};
  const key=envelope.issuer+':'+envelope.nonce;if(seen.has(key))return {ok:false,reason:'replay_detected'};
  const {signature,...body}=envelope;const expected=crypto.createHmac('sha256',secret).update(canonical(body)).digest();let supplied;try{supplied=Buffer.from(signature,'hex')}catch{return {ok:false,reason:'invalid_signature'};}
  if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return {ok:false,reason:'invalid_signature'};
  seen.add(key);return {ok:true,issuer:envelope.issuer,taskId:envelope.task.id,expiresAt:envelope.expiresAt,signatureVerified:true};
 };
}
function createSandbox({id,worker,quorum=3}){
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(id||''))throw Error('invalid sandbox id');
 if(typeof worker!=='function')throw Error('worker callback required');
 async function run(task){
  const started=Date.now(),trace=[]; let prev='0'.repeat(64);
  const emit=(type,detail)=>{const e={seq:trace.length+1,sandboxId:id,taskId:task.id,type,detail,previousHash:prev};e.hash=hash(e);trace.push(e);prev=e.hash;};
  emit('task.accepted',{envelopeHash:task.envelopeHash,inputHash:task.inputHash});
  // Dispatch all four roles concurrently; commit traces in fixed role order for replay stability.
  const settled=await Promise.all(ROLES.map(async role=>{
   try { return {role,result:await worker({sandboxId:id,task,role,outputs:Object.freeze({})})}; }
   catch(e){ return {role,error:String(e.message||e)}; }
  }));
  const outputs={};
  for(const item of settled){
   if(Object.prototype.hasOwnProperty.call(item,'error')){outputs[item.role]={error:item.error};emit('role.failed',{role:item.role,error:item.error});}
   else {outputs[item.role]=item.result;emit('role.completed',{role:item.role,resultHash:hash(item.result)});}
  }
  const votes=ROLES.map(r=>outputs[r]&&outputs[r].vote);
  const complete=votes.every(v=>v===-1||v===0||v===1);
  const decision=complete?decide(votes,{quorum}):{outcome:'defer',reason:'missing_or_invalid_role_vote',radix:3};
  emit('consensus.decided',decision); emit('task.finished',{durationMs:Date.now()-started});
  return {sandboxId:id,taskId:task.id,outputs,decision,trace,traceHead:prev,durationMs:Date.now()-started};
 }
 return Object.freeze({id,run});
}
function createRootConductor({sandboxes,externalVerifier}){
 if(!Array.isArray(sandboxes)||sandboxes.length<1)throw Error('at least one sandbox required');
 if(typeof externalVerifier!=='function')throw Error('independent cross-sandbox verifier required');
 return Object.freeze({async route(task){
  // Fan out to every sandbox concurrently; sort before reduction for replayable consensus.
  const ordered=sandboxes.slice().sort((a,b)=>a.id.localeCompare(b.id));
  const results=await Promise.all(ordered.map(s=>s.run(task)));
  const builderHashes=results.map(r=>hash(r.outputs.builder && Object.prototype.hasOwnProperty.call(r.outputs.builder,'artifact') ? r.outputs.builder.artifact : r.outputs.builder));
  const sameArtifact=builderHashes.every(h=>h===builderHashes[0]);
  const checks=await Promise.all(results.map((result,i)=>externalVerifier({task,result,sourceSandboxId:ordered[i].id,peerResults:results.map((r,j)=>({sandboxId:ordered[j].id,builderHash:builderHashes[j],decision:r.decision.outcome}))})));
  const allApproved=results.every(r=>r.decision.outcome==='approve');
  const allVerified=checks.every((v,i)=>v&&v.ok===true&&v.resultHash===builderHashes[i]);
  const accepted=allApproved&&sameArtifact&&allVerified;
  const rejected=results.some(r=>r.decision.outcome==='reject');
  return {taskId:task.id,sandboxResults:results,rootDecision:accepted?'accepted':rejected?'rejected':'quarantined',sandboxIds:ordered.map(s=>s.id),sandboxId:ordered[0].id,sandboxDecision:results[0].decision,sandboxDecisions:results.map((r,i)=>({sandboxId:ordered[i].id,...r.decision})),independentVerification:checks,artifactsAgree:sameArtifact,accepted,traceHeads:results.map((r,i)=>({sandboxId:ordered[i].id,traceHead:r.traceHead})),traceHead:results[0].traceHead};
 }});
}
module.exports={ROLES,VOTE,canonical,hash,makeTask,signTaskEnvelope,createTaskEnvelopeVerifier,decide,createSandbox,createRootConductor};




