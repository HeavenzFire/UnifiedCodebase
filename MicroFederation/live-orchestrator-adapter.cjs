'use strict';
// Adapter for the existing HeavenzFire orchestrator. Its API permits one active task, so this adapter serializes model work.
class LiveOrchestratorAdapter {
 constructor({endpoint='http://127.0.0.1:8788/task',timeoutMs=120000}={}){this.endpoint=endpoint;this.timeoutMs=timeoutMs;this.queue=Promise.resolve();}
 run({taskId,role,prompt}){
  if(!taskId||!role||typeof prompt!=='string'||!prompt.trim())return Promise.reject(Error('taskId, role and prompt are required'));
  const operation=async()=>{const started=Date.now();const response=await fetch(this.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt}),signal:AbortSignal.timeout(this.timeoutMs)});const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{throw Error('Orchestrator returned non-JSON HTTP '+response.status)}if(!response.ok||data.ok!==true)throw Error('Orchestrator task failed HTTP '+response.status+': '+(data.error||raw.slice(0,200)));return {taskId,role,model:data.model||null,response:data.response||'',elapsedMs:data.elapsed_ms??Date.now()-started,totalDurationNs:data.total_duration_ns||null,httpStatus:response.status,completedAt:new Date().toISOString()};};
  const result=this.queue.then(operation,operation);this.queue=result.then(()=>undefined,()=>undefined);return result;
 }
}
module.exports={LiveOrchestratorAdapter};