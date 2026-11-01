'use strict';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function createOrchestratorTaskWorker({ledger,adapter,workerId,leaseMs=120000,retryDelayMs=1000,clock=()=>Date.now()}){
 if(!ledger||typeof ledger.claimNext!=='function'||typeof ledger.start!=='function'||typeof ledger.complete!=='function'||typeof ledger.fail!=='function')throw Error('a compatible task ledger is required');
 if(!adapter||typeof adapter.run!=='function')throw Error('an orchestrator adapter with run() is required');
 if(typeof workerId!=='string'||!ID.test(workerId))throw Error('workerId is invalid');
 if(typeof clock!=='function')throw Error('clock must be a function');
 if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('leaseMs must be 1000..3600000');
 if(!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>86400000)throw Error('retryDelayMs must be 0..86400000');
 async function runOnce({now=clock()}={}){
  const claimed=await ledger.claimNext(workerId,{now,leaseMs});if(!claimed)return {status:'idle'};
  await ledger.start(claimed.id,workerId,{now});
  try{
   const payload=claimed.payload;
   if(!payload||typeof payload.prompt!=='string'||!payload.prompt.trim())throw Error('task payload must contain a non-empty prompt');
   let timer;
   const result=await Promise.race([
    adapter.run({taskId:claimed.id,role:payload.role||'worker',prompt:payload.prompt}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('orchestrator adapter timed out before task lease expiry')),Math.max(1,leaseMs-5000))})
   ]).finally(()=>clearTimeout(timer));
   const completed=await ledger.complete(claimed.id,workerId,result,{now:clock(),evidenceRef:'orchestrator:'+claimed.id});
   return {status:'succeeded',taskId:claimed.id,result:completed.result,attempts:completed.attempts};
  }catch(error){
   const message=String(error&&error.message||error).slice(0,2048);
   let failed;
   try{failed=await ledger.fail(claimed.id,workerId,message,{retryable:true,retryDelayMs,now:clock()})}
   catch(ledgerError){return {status:'lease-lost',taskId:claimed.id,error:message,ledgerError:String(ledgerError&&ledgerError.message||ledgerError)}}
   return {status:failed.status==='queued'?'retry-scheduled':'failed',taskId:claimed.id,error:message,attempts:failed.attempts,nextAttemptAt:failed.nextAttemptAt||null};
  }
 }
 return Object.freeze({runOnce,workerId});
}
module.exports={createOrchestratorTaskWorker};
