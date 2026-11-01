'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const SCHEMA='heavenzfire.task-ledger.v1';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATES=new Set(['queued','claimed','running','succeeded','failed','cancelled']);
const TERMINAL=new Set(['succeeded','failed','cancelled']);
const clone=v=>JSON.parse(JSON.stringify(v));
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const iso=ms=>new Date(ms).toISOString();

function jsonValue(value,label){
 let encoded;
 try{encoded=JSON.stringify(value)}catch{throw Error(label+' must be JSON-serializable')}
 if(encoded===undefined)throw Error(label+' must be JSON-serializable');
 return JSON.parse(encoded);
}
function validateTaskInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('task input must be an object');
 const allowed=new Set(['id','payload','requiredCapabilities','maxAttempts','idempotencyKey','metadata']);
 for(const key of Object.keys(input))if(!allowed.has(key))throw Error('unsupported task field: '+key);
 if(typeof input.id!=='string'||!ID.test(input.id))throw Error('task id is invalid');
 if(!Object.prototype.hasOwnProperty.call(input,'payload'))throw Error('task payload is required');
 const payload=jsonValue(input.payload,'task payload');
 const caps=input.requiredCapabilities===undefined?[]:input.requiredCapabilities;
 if(!Array.isArray(caps)||caps.length>32||caps.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9._-]{0,63}$/.test(x)))throw Error('requiredCapabilities must contain up to 32 capability slugs');
 const maxAttempts=input.maxAttempts===undefined?3:input.maxAttempts;
 if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)throw Error('maxAttempts must be 1..10');
 const idempotencyKey=input.idempotencyKey===undefined?null:input.idempotencyKey;
 if(idempotencyKey!==null&&(typeof idempotencyKey!=='string'||!ID.test(idempotencyKey)))throw Error('idempotencyKey is invalid');
 const metadata=input.metadata===undefined?{}:jsonValue(input.metadata,'task metadata');
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('task metadata must be an object');
 return {id:input.id,payload,requiredCapabilities:[...new Set(caps)].sort(),maxAttempts,idempotencyKey,metadata};
}
function validRecord(t){
 return !!t&&typeof t==='object'&&!Array.isArray(t)&&ID.test(t.id||'')&&STATES.has(t.status)&&
  Number.isInteger(t.attempts)&&t.attempts>=0&&Number.isInteger(t.maxAttempts)&&t.maxAttempts>=1&&t.maxAttempts<=10&&t.attempts<=t.maxAttempts&&
  Array.isArray(t.requiredCapabilities)&&Array.isArray(t.evidence)&&Array.isArray(t.events)&&
  typeof t.createdAt==='string'&&typeof t.updatedAt==='string'&&
  (t.owner===null||typeof t.owner==='string'&&ID.test(t.owner))&&
  (t.leaseUntil===null||Number.isFinite(t.leaseUntil));
}
class TaskLedger{
 constructor(file){
  if(typeof file!=='string'||!file.trim())throw Error('ledger file path is required');
  this.file=path.resolve(file);this.tasks=[];this.loaded=false;this.opening=null;this.writeQueue=Promise.resolve();
 }
 async open(){
  if(this.loaded)return this;if(this.opening)return this.opening;
  this.opening=(async()=>{
   await fs.mkdir(path.dirname(this.file),{recursive:true});let parsed;
   try{parsed=JSON.parse(await fs.readFile(this.file,'utf8'))}
   catch(e){if(e.code==='ENOENT'){this.tasks=[];this.loaded=true;return this}throw Error('task ledger is unreadable: '+e.message)}
   if(!parsed||parsed.schema!==SCHEMA||!Array.isArray(parsed.tasks))throw Error('task ledger schema is invalid');
   const ids=new Set(),keys=new Set();
   for(const t of parsed.tasks){
    if(!validRecord(t))throw Error('task ledger record is invalid');
    if(ids.has(t.id))throw Error('task ledger contains duplicate id: '+t.id);ids.add(t.id);
    if(t.idempotencyKey){if(keys.has(t.idempotencyKey))throw Error('task ledger contains duplicate idempotency key');keys.add(t.idempotencyKey)}
    jsonValue(t.payload,'persisted task payload');jsonValue(t.result,'persisted task result');
   }
   this.tasks=parsed.tasks;this.loaded=true;return this;
  })().finally(()=>{this.opening=null});
  return this.opening;
 }
 async _persist(tasks){
  const temp=this.file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';let handle;
  try{
   handle=await fs.open(temp,'wx',0o600);
   await handle.writeFile(JSON.stringify({schema:SCHEMA,tasks},null,2)+'\n','utf8');
   await handle.sync();await handle.close();handle=null;await fs.rename(temp,this.file);
  }catch(e){if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});throw e}
 }
 _mutate(change){
  const op=this.writeQueue.then(async()=>{
   await this.open();const next=clone(this.tasks),result=change(next);
   await this._persist(next);this.tasks=next;return result===undefined?null:clone(result);
  });
  this.writeQueue=op.catch(()=>{});return op;
 }
 async create(input,{now=Date.now()}={}){
  const task=validateTaskInput(input);if(!Number.isFinite(now))throw Error('now must be a finite timestamp');
  return this._mutate(tasks=>{
   const existing=tasks.find(t=>t.id===task.id||(task.idempotencyKey&&t.idempotencyKey===task.idempotencyKey));
   const requestHash=digest(task);
   if(existing){if(existing.id!==task.id||existing.requestHash!==requestHash)throw Error('task id or idempotency key already exists with different input');return existing}
   const timestamp=iso(now);
   const record={...task,requestHash,payloadHash:digest(task.payload),status:'queued',owner:null,attempts:0,leaseUntil:null,nextAttemptAt:now,result:null,error:null,createdAt:timestamp,updatedAt:timestamp,startedAt:null,completedAt:null,evidence:[],events:[{type:'task.created',at:timestamp,actor:'system'}]};
   tasks.push(record);return record;
  });
 }
 async claimNext(workerId,{now=Date.now(),leaseMs=60000}={}){
  if(typeof workerId!=='string'||!ID.test(workerId))throw Error('workerId is invalid');
  if(!Number.isFinite(now)||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw Error('claim time or leaseMs is invalid');
  return this._mutate(tasks=>{
   for(const t of tasks.filter(x=>['claimed','running'].includes(x.status)&&x.leaseUntil!==null&&x.leaseUntil<=now&&x.attempts>=x.maxAttempts)){
    t.status='failed';t.owner=null;t.leaseUntil=null;t.completedAt=iso(now);t.updatedAt=t.completedAt;t.error='worker lease expired after maximum attempts';
    t.events.push({type:'task.failed',at:t.updatedAt,actor:'system',attempt:t.attempts,error:t.error});
   }
   const candidate=tasks.filter(t=>(t.status==='queued'&&t.nextAttemptAt<=now)||(['claimed','running'].includes(t.status)&&t.leaseUntil!==null&&t.leaseUntil<=now&&t.attempts<t.maxAttempts))
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
   if(!candidate)return null;
   const reclaimed=['claimed','running'].includes(candidate.status);
   candidate.status='claimed';candidate.owner=workerId;candidate.attempts++;candidate.leaseUntil=now+leaseMs;candidate.updatedAt=iso(now);
   candidate.events.push({type:reclaimed?'task.lease_reclaimed':'task.claimed',at:candidate.updatedAt,actor:workerId,attempt:candidate.attempts});
   return candidate;
  });
 }
 async start(taskId,workerId,{now=Date.now()}={}){
  return this._mutate(tasks=>{
   const t=tasks.find(x=>x.id===taskId);if(!t)throw Error('unknown task: '+taskId);
   if(t.status!=='claimed'||t.owner!==workerId)throw Error('task is not claimed by this worker');
   if(t.leaseUntil<=now)throw Error('task lease has expired');
   t.status='running';t.startedAt=t.startedAt||iso(now);t.updatedAt=iso(now);
   t.events.push({type:'task.started',at:t.updatedAt,actor:workerId,attempt:t.attempts});return t;
  });
 }
 async complete(taskId,workerId,result,{now=Date.now(),evidenceRef=null}={}){
  const safe=jsonValue(result,'task result');
  if(evidenceRef!==null&&(typeof evidenceRef!=='string'||!evidenceRef.trim()||evidenceRef.length>512))throw Error('evidenceRef is invalid');
  return this._mutate(tasks=>{
   const t=tasks.find(x=>x.id===taskId);if(!t)throw Error('unknown task: '+taskId);
   if(t.status!=='running'||t.owner!==workerId)throw Error('task is not running under this worker');
   if(t.leaseUntil!==null&&t.leaseUntil<=now)throw Error('task lease has expired');
   t.status='succeeded';t.result=safe;t.error=null;t.leaseUntil=null;t.completedAt=iso(now);t.updatedAt=t.completedAt;
   if(evidenceRef)t.evidence.push({ref:evidenceRef,at:t.updatedAt,actor:workerId});
   t.events.push({type:'task.succeeded',at:t.updatedAt,actor:workerId,attempt:t.attempts});return t;
  });
 }
 async fail(taskId,workerId,error,{now=Date.now(),retryable=true,retryDelayMs=0}={}){
  if(typeof error!=='string'||!error.trim()||error.length>2048)throw Error('error is invalid');
  if(typeof retryable!=='boolean'||!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>86400000)throw Error('retry policy is invalid');
  return this._mutate(tasks=>{
   const t=tasks.find(x=>x.id===taskId);if(!t)throw Error('unknown task: '+taskId);
   if(t.status!=='running'||t.owner!==workerId)throw Error('task is not running under this worker');
   if(t.leaseUntil!==null&&t.leaseUntil<=now)throw Error('task lease has expired');
   const retry=retryable&&t.attempts<t.maxAttempts;t.error=error;t.owner=null;t.leaseUntil=null;t.updatedAt=iso(now);
   if(retry){t.status='queued';t.nextAttemptAt=now+retryDelayMs;t.events.push({type:'task.retry_scheduled',at:t.updatedAt,actor:workerId,attempt:t.attempts,nextAttemptAt:t.nextAttemptAt,error})}
   else{t.status='failed';t.completedAt=t.updatedAt;t.events.push({type:'task.failed',at:t.updatedAt,actor:workerId,attempt:t.attempts,error})}
   return t;
  });
 }
 async cancel(taskId,reason,{now=Date.now(),actor='operator'}={}){
  if(typeof reason!=='string'||!reason.trim()||reason.length>512)throw Error('cancellation reason is required');
  return this._mutate(tasks=>{
   const t=tasks.find(x=>x.id===taskId);if(!t)throw Error('unknown task: '+taskId);
   if(TERMINAL.has(t.status))throw Error('terminal task cannot be cancelled');
   t.status='cancelled';t.owner=null;t.leaseUntil=null;t.completedAt=iso(now);t.updatedAt=t.completedAt;
   t.events.push({type:'task.cancelled',at:t.updatedAt,actor,reason});return t;
  });
 }
 async addEvidence(taskId,ref,{now=Date.now(),actor='system'}={}){
  if(typeof ref!=='string'||!ref.trim()||ref.length>512)throw Error('evidence reference is invalid');
  return this._mutate(tasks=>{
   const t=tasks.find(x=>x.id===taskId);if(!t)throw Error('unknown task: '+taskId);
   t.evidence.push({ref,at:iso(now),actor});t.updatedAt=iso(now);
   t.events.push({type:'task.evidence_added',at:t.updatedAt,actor,evidenceRef:ref});return t;
  });
 }
 async get(id){await this.open();const t=this.tasks.find(x=>x.id===id);return t?clone(t):null}
 async list({status=null}={}){await this.open();if(status!==null&&!STATES.has(status))throw Error('unknown task status');return clone(this.tasks.filter(t=>status===null||t.status===status).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)))}
 async stats(){const tasks=await this.list();return {total:tasks.length,byStatus:Object.fromEntries([...STATES].map(s=>[s,tasks.filter(t=>t.status===s).length])),attempts:tasks.reduce((n,t)=>n+t.attempts,0)}}
}
module.exports={TaskLedger,TASK_STATES:Object.freeze([...STATES]),validateTaskInput};
