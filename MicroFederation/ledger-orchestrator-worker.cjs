'use strict';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function reasonText(reason){
 if(typeof reason==='string'&&reason.trim())return reason.trim().slice(0,512);
 if(reason&&typeof reason.message==='string'&&reason.message.trim())return reason.message.trim().slice(0,512);
 return 'operator requested cancellation';
}
function abortError(reason){
 const error=Error(reasonText(reason));
 error.name='AbortError';
 return error;
}
function isAbortSignal(signal){
 return !!signal&&typeof signal.aborted==='boolean'&&
  typeof signal.addEventListener==='function'&&typeof signal.removeEventListener==='function';
}

function createOrchestratorTaskWorker({ledger,adapter,workerId,leaseMs=120000,retryDelayMs=1000,clock=()=>Date.now()}){
 if(!ledger||typeof ledger.claimNext!=='function'||typeof ledger.start!=='function'||
    typeof ledger.complete!=='function'||typeof ledger.fail!=='function'||
    typeof ledger.cancel!=='function'||typeof ledger.get!=='function')throw Error('a compatible cancellable task ledger is required');
 if(!adapter||typeof adapter.run!=='function')throw Error('an orchestrator adapter with run() is required');
 if(typeof workerId!=='string'||!ID.test(workerId))throw Error('workerId is invalid');
 if(typeof clock!=='function')throw Error('clock must be a function');
 if(!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('leaseMs must be 1000..3600000');
 if(!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>86400000)throw Error('retryDelayMs must be 0..86400000');

 async function currentTask(taskId){
  try{return await ledger.get(taskId)}catch{return null}
 }
 async function cancelTask(taskId,reason){
  const text=reasonText(reason);
  try{
   const cancelled=await ledger.cancel(taskId,text,{now:clock(),actor:workerId});
   return {status:'cancelled',taskId,attempts:cancelled.attempts,executionMayContinue:true};
  }catch(error){
   const current=await currentTask(taskId);
   if(current&&current.status==='cancelled')return {status:'cancelled',taskId,attempts:current.attempts,executionMayContinue:true};
   if(current&&current.status==='succeeded')return {status:'succeeded',taskId,result:current.result,completedBeforeCancellation:true};
   return {status:'cancel-unconfirmed',taskId,error:String(error&&error.message||error),executionMayContinue:true};
  }
 }
 async function recordFailure(claimed,error,{retryable=true,status=null,executionMayContinue=false}={}){
  const message=String(error&&error.message||error).slice(0,2048);
  try{
   const failed=await ledger.fail(claimed.id,workerId,message,{retryable,retryDelayMs,now:clock()});
   return {
    status:status|| (failed.status==='queued'?'retry-scheduled':'failed'),
    taskId:claimed.id,error:message,attempts:failed.attempts,
    nextAttemptAt:failed.nextAttemptAt||null,executionMayContinue
   };
  }catch(ledgerError){
   const current=await currentTask(claimed.id);
   if(current&&current.status==='cancelled')return {status:'cancelled',taskId:claimed.id,attempts:current.attempts,executionMayContinue:true};
   if(current&&current.status==='succeeded')return {status:'succeeded',taskId:claimed.id,result:current.result,completedBeforeCancellation:true};
   return {
    status:'lease-lost',taskId:claimed.id,error:message,
    ledgerError:String(ledgerError&&ledgerError.message||ledgerError),executionMayContinue
   };
  }
 }

 async function runOnce({now=clock(),signal}={}){
  if(signal!==undefined&&signal!==null&&!isAbortSignal(signal))throw Error('signal must be an AbortSignal');
  if(signal&&signal.aborted)return {status:'cancelled-before-claim'};

  const claimed=await ledger.claimNext(workerId,{now,leaseMs});
  if(!claimed)return {status:'idle'};
  if(signal&&signal.aborted)return cancelTask(claimed.id,signal.reason||'cancelled before task start');

  await ledger.start(claimed.id,workerId,{now});
  if(signal&&signal.aborted)return cancelTask(claimed.id,signal.reason||'cancelled before adapter start');

  const controller=new AbortController();
  let callerAborted=false;
  let timeoutFired=false;
  let timeoutId=null;
  let rejectAbort=null;
  const onCallerAbort=()=>{
   callerAborted=true;
   if(!controller.signal.aborted)controller.abort(signal.reason);
  };
  if(signal){
   signal.addEventListener('abort',onCallerAbort,{once:true});
   if(signal.aborted)onCallerAbort();
  }
  const abortPromise=new Promise((_,reject)=>{
   rejectAbort=()=>reject(abortError(controller.signal.reason));
   if(controller.signal.aborted)rejectAbort();
   else controller.signal.addEventListener('abort',rejectAbort,{once:true});
  });
  timeoutId=setTimeout(()=>{
   timeoutFired=true;
   const error=Error('orchestrator adapter timed out before task lease expiry');
   error.code='HF_ORCHESTRATOR_TIMEOUT';
   controller.abort(error);
  },Math.max(1,leaseMs-5000));

  try{
   const payload=claimed.payload;
   if(!payload||typeof payload.prompt!=='string'||!payload.prompt.trim())throw Error('task payload must contain a non-empty prompt');
   const adapterPromise=Promise.resolve().then(()=>{
    if(controller.signal.aborted)throw abortError(controller.signal.reason);
    return adapter.run({taskId:claimed.id,role:payload.role||'worker',prompt:payload.prompt,signal:controller.signal});
   });
   const result=await Promise.race([adapterPromise,abortPromise]);
   if(timeoutId!==null){clearTimeout(timeoutId);timeoutId=null;}
   if(callerAborted)return cancelTask(claimed.id,signal.reason);
   if(controller.signal.aborted){
    if(timeoutFired)throw Error('orchestrator adapter timed out before task lease expiry');
    throw abortError(controller.signal.reason);
   }
   const completed=await ledger.complete(claimed.id,workerId,result,{now:clock(),evidenceRef:'orchestrator:'+claimed.id});
   if(callerAborted)return {status:'succeeded',taskId:claimed.id,result:completed.result,attempts:completed.attempts,completedBeforeCancellation:true};
   return {status:'succeeded',taskId:claimed.id,result:completed.result,attempts:completed.attempts};
  }catch(error){
   if(timeoutId!==null){clearTimeout(timeoutId);timeoutId=null;}
   if(callerAborted)return cancelTask(claimed.id,signal.reason);
   if(timeoutFired){
    return recordFailure(claimed,error,{retryable:false,status:'timed-out',executionMayContinue:true});
   }
   return recordFailure(claimed,error,{retryable:true});
  }finally{
   if(timeoutId!==null)clearTimeout(timeoutId);
   if(signal)signal.removeEventListener('abort',onCallerAbort);
   if(rejectAbort)controller.signal.removeEventListener('abort',rejectAbort);
  }
 }
 return Object.freeze({runOnce,workerId});
}
module.exports={createOrchestratorTaskWorker};
