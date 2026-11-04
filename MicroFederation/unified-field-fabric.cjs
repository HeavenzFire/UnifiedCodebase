'use strict';
const crypto=require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const {createPixelMesh}=require('./pixel-mesh.cjs');
const {createNonlinearWorkflow}=require('./nonlinear-workflow.cjs');
const FABRIC_CAPABILITY='unified-field-fabric.v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function createUnifiedFieldFabric({ledger,mesh=createPixelMesh(),workflow=createNonlinearWorkflow(),workerAdapters={},authorizeWorker,approvalGate=null,chooseBranchPolicy,coordinatorId='unified-field-coordinator',leaseMs=120000,workerWaitMs=30000,workerPollMs=25,clock=()=>Date.now()}={}){
 if(!ledger||!['create','claimNext','start','complete','fail','renewLease'].every(k=>typeof ledger[k]==='function'))throw Error('durable TaskLedger with lease renewal is required');
 if(typeof authorizeWorker!=='function')throw Error('trusted authorizeWorker policy is required');
 if(chooseBranchPolicy!==undefined&&typeof chooseBranchPolicy!=='function')throw Error('chooseBranchPolicy must be a trusted function');
 if(!workerAdapters||typeof workerAdapters!=='object'||Array.isArray(workerAdapters))throw Error('workerAdapters must be an object');
 if(typeof coordinatorId!=='string'||!ID.test(coordinatorId))throw Error('coordinatorId is invalid');
 if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('leaseMs is invalid');
 if(!Number.isInteger(workerWaitMs)||workerWaitMs<0||workerWaitMs>300000||!Number.isInteger(workerPollMs)||workerPollMs<5||workerPollMs>1000)throw Error('worker capacity wait policy is invalid');
 const active=new Map();
 async function submit({id,workflowId,nodes,input={},idempotencyKey=null,maxAttempts=3,principal,producerProof}={}){
  if(typeof workflowId!=='string'||!ID.test(workflowId)||!nodes||typeof nodes!=='object'||Array.isArray(nodes))throw Error('workflowId and nodes are required');
  if(typeof principal!=='string'||!ID.test(principal))throw Error('authenticated producer principal is required');
  return ledger.create({id,payload:{workflowId,nodes,input},requiredCapabilities:[FABRIC_CAPABILITY],idempotencyKey,maxAttempts,metadata:{source:'unified-field-fabric',version:'0.2'}},{now:clock(),principal,producerProof});
 }
 async function runOne({now=clock()}={}){
  const task=await ledger.claimNext(coordinatorId,{now,leaseMs,requiredCapabilities:[FABRIC_CAPABILITY]});if(!task)return {status:'idle'};
  let started=false,timer=null,renewal=Promise.resolve(),leaseError=null,payload=null,workflowResult=null;
  try{
   await ledger.start(task.id,coordinatorId,{now:clock()});started=true;
   timer=setInterval(()=>{renewal=renewal.then(()=>ledger.renewLease(task.id,coordinatorId,{now:clock(),leaseMs})).catch(error=>{leaseError=error;});},Math.max(250,Math.floor(leaseMs/3)));
   if(timer.unref)timer.unref();
   payload=task.payload;if(!payload||typeof payload.workflowId!=='string'||!payload.nodes||typeof payload.nodes!=='object')throw Error('ledger task does not contain a valid workflow payload');
   workflowResult=await workflow.run({workflowId:payload.workflowId,nodes:payload.nodes,input:payload.input||{},execute:async ctx=>{
    if(leaseError)throw Error('task lease renewal failed');
    const node=payload.nodes[ctx.nodeId],capability=node.capability;
    if(typeof capability!=='string'||!capability.trim())throw Error('workflow node must declare a worker capability: '+ctx.nodeId);
    if(node.approvalRequired===true){
     if(!approvalGate||typeof approvalGate.verify!=='function')throw Error('independent approval gate is not configured');
     const action=typeof node.action==='string'?node.action:capability,subject=typeof node.subject==='string'?node.subject:task.metadata.provenance.subject;
     const approval=approvalGate.verify({approval:node.approval,taskId:task.id,nodeId:ctx.nodeId,action,subject});
     if(!approval.ok)throw Error('independent approval denied: '+approval.reason);
    }
    const candidates=mesh.selectWorkers({capability,role:node.role||null,limit:4096,now:clock()})
     .filter(peer=>Object.prototype.hasOwnProperty.call(workerAdapters,peer.peerId)&&typeof workerAdapters[peer.peerId]==='function');
    if(!candidates.length)throw Error('no worker adapter available for capability '+capability);
    let selected=null,grant=null,waited=0;const denied=new Set();
    while(!selected){
     if(leaseError)throw Error('task lease renewal failed');
     let sawBusy=false;
     for(const peer of candidates){
      if(denied.has(peer.peerId))continue;
      const current=(active.get(peer.peerId)||0);
      if(current>=peer.capacity){sawBusy=true;continue;}
      active.set(peer.peerId,current+1);
      let decision;
      try{decision=await authorizeWorker({taskId:task.id,workflowId:payload.workflowId,nodeId:ctx.nodeId,capability,peerId:peer.peerId,producer:task.metadata.provenance});}
      catch(error){const count=(active.get(peer.peerId)||1)-1;if(count)active.set(peer.peerId,count);else active.delete(peer.peerId);throw error;}
      if(decision&&decision.ok===true&&decision.taskId===task.id&&decision.nodeId===ctx.nodeId&&decision.capability===capability&&decision.peerId===peer.peerId&&Number.isFinite(decision.expiresAt)&&decision.expiresAt>clock()&&typeof decision.issuer==='string'&&typeof decision.grantId==='string'){selected=peer;grant=decision;break;}
      const count=(active.get(peer.peerId)||1)-1;if(count)active.set(peer.peerId,count);else active.delete(peer.peerId);
      denied.add(peer.peerId);
     }
     if(selected)break;
     if(!sawBusy)throw Error('no independently authorized worker available for capability '+capability);
     if(waited>=workerWaitMs)throw Error('worker capacity wait timed out for capability '+capability);
     const interval=Math.min(workerPollMs,workerWaitMs-waited);
     await delay(interval);waited+=interval;
    }
    try{return await workerAdapters[selected.peerId]({...ctx,taskId:task.id,peerId:selected.peerId,capability,authorization:{issuer:grant.issuer,grantId:grant.grantId,expiresAt:grant.expiresAt}});}
    finally{const count=(active.get(selected.peerId)||1)-1;if(count)active.set(selected.peerId,count);else active.delete(selected.peerId);}
   },chooseBranch:chooseBranchPolicy});
   if(timer)clearInterval(timer);timer=null;await renewal;if(leaseError)throw Error('task lease renewal failed');
   if(workflowResult.status!=='succeeded'){
    const message='workflow execution failed: '+workflowResult.events.filter(e=>e.type==='node.failed').map(e=>e.detail.error).join('; ');
    const failureResult=buildFailureTrace(workflowResult,payload.workflowId,message);
    const failed=await ledger.fail(task.id,coordinatorId,message.slice(0,2048),{now:clock(),retryable:false,failureResult});
    return {status:'failed',taskId:task.id,error:message,ledgerStatus:failed.status,failureTrace:failed.result};
   }
   const completed=await ledger.complete(task.id,coordinatorId,workflowResult,{now:clock(),evidenceRef:'workflow:'+payload.workflowId});
   return {status:'succeeded',taskId:task.id,result:completed.result,workflowId:payload.workflowId};
  }catch(error){
   if(timer)clearInterval(timer);await renewal;
   const message=String(error&&error.message||error).slice(0,2048);
   try{
    const failed=started
     ?await ledger.fail(task.id,coordinatorId,message,{now:clock(),retryable:false,failureResult:buildFailureTrace(workflowResult,payload&&payload.workflowId,message)})
     :await ledger.releaseClaim(task.id,coordinatorId,{now:clock(),reason:message});
    return {status:'failed',taskId:task.id,error:message,ledgerStatus:failed.status,failureTrace:failed.result||null};
   }catch(ledgerError){return {status:'recovery_required',taskId:task.id,error:message,recoveryError:String(ledgerError.message||ledgerError).slice(0,512)};}
  }
 }
 return Object.freeze({mesh,submit,runOne,coordinatorId});
}

function buildFailureTrace(result,workflowId,error){
 const nodeStates=Object.fromEntries(Object.entries(result&&result.nodeStates||{}).slice(0,256).map(([id,state])=>[id,{
  status:typeof state.status==='string'?state.status:'unknown',
  attempts:Number.isInteger(state.attempts)?state.attempts:0,
  error:typeof state.error==='string'?state.error.slice(0,512):null
 }]));
 const events=(result&&Array.isArray(result.events)?result.events:[]).slice(-128).map(event=>({
  seq:Number.isInteger(event.seq)?event.seq:null,
  at:Number.isFinite(event.at)?event.at:null,
  type:typeof event.type==='string'?event.type.slice(0,80):'unknown',
  detail:{
   nodeId:typeof event.detail?.nodeId==='string'?event.detail.nodeId.slice(0,128):null,
   error:typeof event.detail?.error==='string'?event.detail.error.slice(0,512):null,
   condition:typeof event.detail?.condition==='string'?event.detail.condition.slice(0,128):null
  }
 }));
 const outputDigests={};
 for(const [id,value] of Object.entries(result&&result.outputs||{}).slice(0,64)){
  try{const encoded=JSON.stringify(value);if(encoded!==undefined)outputDigests[id]={sha256:crypto.createHash('sha256').update(encoded).digest('hex'),bytes:Buffer.byteLength(encoded,'utf8')};}
  catch{outputDigests[id]={unavailable:true};}
 }
 return {
  schema:'heavenzfire.workflow-failure.v1',
  workflowId:typeof workflowId==='string'?workflowId:null,
  error:typeof error==='string'?error.slice(0,1024):null,
  summary:result&&result.summary?{
   total:result.summary.total,succeeded:result.summary.succeeded,skipped:result.summary.skipped,
   failed:result.summary.failed,maxConcurrent:result.summary.maxConcurrent,peakConcurrency:result.summary.peakConcurrency
  }:null,
  nodeStates,events,outputDigests
 };
}

module.exports={createUnifiedFieldFabric,FABRIC_CAPABILITY};
