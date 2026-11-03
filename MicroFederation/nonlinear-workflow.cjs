'use strict';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function createNonlinearWorkflow({maxConcurrent=8,clock=()=>Date.now()}={}){
 if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>256)throw Error('maxConcurrent must be 1..256');
 async function run({workflowId,nodes,input={},execute,chooseBranch=()=>true}){
  if(typeof workflowId!=='string'||!ID.test(workflowId))throw Error('workflowId is invalid');
  if(!nodes||typeof nodes!=='object'||Array.isArray(nodes)||!Object.keys(nodes).length)throw Error('nodes must be a non-empty object');
  if(typeof execute!=='function'||typeof chooseBranch!=='function')throw Error('execute and chooseBranch callbacks are required');
  const ids=Object.keys(nodes);for(const id of ids){if(!ID.test(id))throw Error('invalid node id: '+id);const n=nodes[id];if(!n||typeof n!=='object'||!Array.isArray(n.dependsOn||[])||(n.dependsOn||[]).some(d=>!ids.includes(d)))throw Error('invalid node or dependency: '+id);}
  const state=new Map(ids.map(id=>[id,{status:'pending',attempts:0,result:null,error:null}]));
  const events=[];const outputs={};let active=0,peakActive=0;
  const emit=(type,detail)=>events.push({seq:events.length+1,at:clock(),type,detail});
  // Detect cycles before executing any user code.
  const visiting=new Set(),visited=new Set();
  function visit(id){if(visiting.has(id))throw Error('workflow contains a dependency cycle at '+id);if(visited.has(id))return;visiting.add(id);for(const d of nodes[id].dependsOn||[])visit(d);visiting.delete(id);visited.add(id);}
  ids.forEach(visit);
  const pending=new Set(ids);let failure=null;
  while(pending.size&&!failure){
   const ready=[...pending].filter(id=>(nodes[id].dependsOn||[]).every(d=>['succeeded','skipped'].includes(state.get(d).status)));
   if(!ready.length){failure='workflow_deadlock_or_failed_dependency';break;}
   const runnable=[];
   for(const id of ready){
    const n=nodes[id],deps=(n.dependsOn||[]).map(d=>outputs[d]);
    if(typeof n.when==='string'&&!chooseBranch({expression:n.when,nodeId:id,input,dependencies:deps,outputs:{...outputs}})){
     state.set(id,{status:'skipped',attempts:0,result:null,error:null});pending.delete(id);emit('node.skipped',{nodeId:id,condition:n.when});continue;
    }
    runnable.push(id);
   }
   for(let i=0;i<runnable.length;i+=maxConcurrent){
    const batch=runnable.slice(i,i+maxConcurrent);
    await Promise.all(batch.map(async id=>{
     const n=nodes[id],s=state.get(id);s.status='running';s.attempts++;active++;peakActive=Math.max(peakActive,active);emit('node.started',{nodeId:id,attempt:s.attempts});
     try{
      const result=await execute({workflowId,nodeId:id,kind:n.kind||'work',input,dependencies:(n.dependsOn||[]).map(d=>({nodeId:d,result:outputs[d]})),outputs:{...outputs}});
      outputs[id]=result;s.status='succeeded';s.result=result;emit('node.succeeded',{nodeId:id});
     }catch(error){s.status='failed';s.error=String(error&&error.message||error).slice(0,1024);failure='node_failed';emit('node.failed',{nodeId:id,error:s.error});}
     finally{active--;pending.delete(id);}
    }));
    if(failure)break;
   }
  }
  const succeeded=[...state.values()].filter(s=>s.status==='succeeded').length,skipped=[...state.values()].filter(s=>s.status==='skipped').length,failed=[...state.values()].filter(s=>s.status==='failed').length;
  const status=failure?'failed':failed?'failed':'succeeded';
  emit('workflow.finished',{status,succeeded,skipped,failed});
  return {workflowId,status,outputs,nodeStates:Object.fromEntries([...state].map(([id,s])=>[id,{...s}])),events,summary:{total:ids.length,succeeded,skipped,failed,maxConcurrent,peakConcurrency:peakActive}};
 }
 return Object.freeze({run});
}
module.exports={createNonlinearWorkflow};
