'use strict';
const {createPixelMesh}=require('./pixel-mesh.cjs');
const {createNonlinearWorkflow}=require('./nonlinear-workflow.cjs');
function createUnifiedFieldFabric({ledger,mesh=createPixelMesh(),workflow=createNonlinearWorkflow(),workerAdapters={},coordinatorId='unified-field-coordinator',leaseMs=120000,clock=()=>Date.now()}={}){
 if(!ledger||!['create','claimNext','start','complete','fail'].every(k=>typeof ledger[k]==='function'))throw Error('durable TaskLedger is required');
 if(typeof coordinatorId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(coordinatorId))throw Error('coordinatorId is invalid');
 if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('leaseMs is invalid');
 const active=new Map();
 async function submit({id,workflowId,nodes,input={},idempotencyKey=null,maxAttempts=3}){
  if(!workflowId||!nodes||typeof nodes!=='object')throw Error('workflowId and nodes are required');
  return ledger.create({id,payload:{workflowId,nodes,input},requiredCapabilities:[],idempotencyKey,maxAttempts,metadata:{source:'unified-field-fabric',version:'0.1'}},{now:clock()});
 }
 async function runOne({now=clock()}={}){
  const task=await ledger.claimNext(coordinatorId,{now,leaseMs});if(!task)return {status:'idle'};
  await ledger.start(task.id,coordinatorId,{now:clock()});
  try{
   const payload=task.payload;if(!payload||typeof payload.workflowId!=='string'||!payload.nodes)throw Error('ledger task does not contain a valid workflow payload');
   const result=await workflow.run({workflowId:payload.workflowId,nodes:payload.nodes,input:payload.input||{},execute:async ctx=>{
    const node=payload.nodes[ctx.nodeId],capability=node.capability;
    if(typeof capability!=='string'||!capability.trim())throw Error('workflow node must declare a worker capability: '+ctx.nodeId);
    const candidates=mesh.selectWorkers({capability,role:node.role||null,limit:256,now:clock()});
    const peer=candidates.find(p=>(active.get(p.peerId)||0)<p.capacity&&typeof workerAdapters[p.peerId]==='function');
    if(!peer)throw Error('no available authorized mesh worker for capability '+capability);
    active.set(peer.peerId,(active.get(peer.peerId)||0)+1);
    try{return await workerAdapters[peer.peerId]({...ctx,taskId:task.id,peerId:peer.peerId,capability});}
    finally{const count=(active.get(peer.peerId)||1)-1;if(count)active.set(peer.peerId,count);else active.delete(peer.peerId);}
   }});
   if(result.status!=='succeeded')throw Error('workflow execution failed: '+result.events.filter(e=>e.type==='node.failed').map(e=>e.detail.error).join('; '));
   const completed=await ledger.complete(task.id,coordinatorId,result,{now:clock(),evidenceRef:'workflow:'+payload.workflowId});
   return {status:'succeeded',taskId:task.id,result:completed.result,workflowId:payload.workflowId};
  }catch(error){
   const message=String(error&&error.message||error).slice(0,2048);
   const failed=await ledger.fail(task.id,coordinatorId,message,{now:clock(),retryable:false});
   return {status:'failed',taskId:task.id,error:message,ledgerStatus:failed.status};
  }
 }
 return Object.freeze({mesh,submit,runOne,coordinatorId});
}
module.exports={createUnifiedFieldFabric};
