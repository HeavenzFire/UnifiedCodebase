'use strict';
const {createPixelMesh}=require('./pixel-mesh.cjs');
const {createNonlinearWorkflow}=require('./nonlinear-workflow.cjs');
const FABRIC_CAPABILITY='unified-field-fabric.v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function createUnifiedFieldFabric({ledger,mesh=createPixelMesh(),workflow=createNonlinearWorkflow(),workerAdapters={},authorizeWorker,approvalGate=null,chooseBranchPolicy,coordinatorId='unified-field-coordinator',leaseMs=120000,clock=()=>Date.now()}={}){
 if(!ledger||!['create','claimNext','start','complete','fail','renewLease'].every(k=>typeof ledger[k]==='function'))throw Error('durable TaskLedger with lease renewal is required');
 if(typeof authorizeWorker!=='function')throw Error('trusted authorizeWorker policy is required');
 if(chooseBranchPolicy!==undefined&&typeof chooseBranchPolicy!=='function')throw Error('chooseBranchPolicy must be a trusted function');
 if(!workerAdapters||typeof workerAdapters!=='object'||Array.isArray(workerAdapters))throw Error('workerAdapters must be an object');
 if(typeof coordinatorId!=='string'||!ID.test(coordinatorId))throw Error('coordinatorId is invalid');
 if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('leaseMs is invalid');
 const active=new Map();
 async function submit({id,workflowId,nodes,input={},idempotencyKey=null,maxAttempts=3,principal,producerProof}={}){
  if(typeof workflowId!=='string'||!ID.test(workflowId)||!nodes||typeof nodes!=='object'||Array.isArray(nodes))throw Error('workflowId and nodes are required');
  if(typeof principal!=='string'||!ID.test(principal))throw Error('authenticated producer principal is required');
  return ledger.create({id,payload:{workflowId,nodes,input},requiredCapabilities:[FABRIC_CAPABILITY],idempotencyKey,maxAttempts,metadata:{source:'unified-field-fabric',version:'0.2'}},{now:clock(),principal,producerProof});
 }
 async function runOne({now=clock()}={}){
  const task=await ledger.claimNext(coordinatorId,{now,leaseMs,requiredCapabilities:[FABRIC_CAPABILITY]});if(!task)return {status:'idle'};
  let started=false,timer=null,renewal=Promise.resolve(),leaseError=null;
  try{
   await ledger.start(task.id,coordinatorId,{now:clock()});started=true;
   timer=setInterval(()=>{renewal=renewal.then(()=>ledger.renewLease(task.id,coordinatorId,{now:clock(),leaseMs})).catch(error=>{leaseError=error;});},Math.max(250,Math.floor(leaseMs/3)));
   if(timer.unref)timer.unref();
   const payload=task.payload;if(!payload||typeof payload.workflowId!=='string'||!payload.nodes||typeof payload.nodes!=='object')throw Error('ledger task does not contain a valid workflow payload');
   const result=await workflow.run({workflowId:payload.workflowId,nodes:payload.nodes,input:payload.input||{},execute:async ctx=>{
    if(leaseError)throw Error('task lease renewal failed');
    const node=payload.nodes[ctx.nodeId],capability=node.capability;
    if(typeof capability!=='string'||!capability.trim())throw Error('workflow node must declare a worker capability: '+ctx.nodeId);
    if(node.approvalRequired===true){
     if(!approvalGate||typeof approvalGate.verify!=='function')throw Error('independent approval gate is not configured');
     const action=typeof node.action==='string'?node.action:capability,subject=typeof node.subject==='string'?node.subject:task.metadata.provenance.subject;
     const approval=approvalGate.verify({approval:node.approval,taskId:task.id,nodeId:ctx.nodeId,action,subject});
     if(!approval.ok)throw Error('independent approval denied: '+approval.reason);
    }
    const candidates=mesh.selectWorkers({capability,role:node.role||null,limit:4096,now:clock()});
    let selected=null,grant=null;
    for(const peer of candidates){
     if((active.get(peer.peerId)||0)>=peer.capacity||!Object.prototype.hasOwnProperty.call(workerAdapters,peer.peerId)||typeof workerAdapters[peer.peerId]!=='function')continue;
     const decision=await authorizeWorker({taskId:task.id,workflowId:payload.workflowId,nodeId:ctx.nodeId,capability,peerId:peer.peerId,producer:task.metadata.provenance});
     if(decision&&decision.ok===true&&decision.taskId===task.id&&decision.nodeId===ctx.nodeId&&decision.capability===capability&&decision.peerId===peer.peerId&&Number.isFinite(decision.expiresAt)&&decision.expiresAt>clock()&&typeof decision.issuer==='string'&&typeof decision.grantId==='string'){selected=peer;grant=decision;break;}
    }
    if(!selected)throw Error('no independently authorized worker available for capability '+capability);
    active.set(selected.peerId,(active.get(selected.peerId)||0)+1);
    try{return await workerAdapters[selected.peerId]({...ctx,taskId:task.id,peerId:selected.peerId,capability,authorization:{issuer:grant.issuer,grantId:grant.grantId,expiresAt:grant.expiresAt}});}
    finally{const count=(active.get(selected.peerId)||1)-1;if(count)active.set(selected.peerId,count);else active.delete(selected.peerId);}
   },chooseBranch:chooseBranchPolicy});
   if(timer)clearInterval(timer);await renewal;if(leaseError)throw Error('task lease renewal failed');
   if(result.status!=='succeeded')throw Error('workflow execution failed: '+result.events.filter(e=>e.type==='node.failed').map(e=>e.detail.error).join('; '));
   const completed=await ledger.complete(task.id,coordinatorId,result,{now:clock(),evidenceRef:'workflow:'+payload.workflowId});
   return {status:'succeeded',taskId:task.id,result:completed.result,workflowId:payload.workflowId};
  }catch(error){
   if(timer)clearInterval(timer);await renewal;
   const message=String(error&&error.message||error).slice(0,2048);
   try{const failed=started?await ledger.fail(task.id,coordinatorId,message,{now:clock(),retryable:false}):await ledger.releaseClaim(task.id,coordinatorId,{now:clock(),reason:message});return {status:'failed',taskId:task.id,error:message,ledgerStatus:failed.status};}
   catch(ledgerError){return {status:'recovery_required',taskId:task.id,error:message,recoveryError:String(ledgerError.message||ledgerError).slice(0,512)};}
  }
 }
 return Object.freeze({mesh,submit,runOne,coordinatorId});
}
module.exports={createUnifiedFieldFabric,FABRIC_CAPABILITY};
