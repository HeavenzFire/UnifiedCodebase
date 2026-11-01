'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

const SCHEMA='heavenzfire.provider-registry.v1';
const STATES=new Set(['configured','authenticated','smoke-tested','capability-tested','degraded','disabled']);
const TRANSITIONS={
 configured:new Set(['authenticated','degraded','disabled']),
 authenticated:new Set(['smoke-tested','degraded','disabled','configured']),
 'smoke-tested':new Set(['capability-tested','degraded','disabled','configured']),
 'capability-tested':new Set(['degraded','disabled','configured']),
 degraded:new Set(['configured','authenticated','disabled']),
 disabled:new Set(['configured'])
};
const ID=/^[a-z][a-z0-9._-]{0,63}$/;
const SLUG=/^[a-z][a-z0-9-]{0,63}$/;
const ENV=/^[A-Z_][A-Z0-9_]{0,127}$/;
const clone=value=>JSON.parse(JSON.stringify(value));

function validateProvider(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('provider definition must be an object');
 const allowed=new Set(['id','provider','model','capabilities','credentialEnv']);
 for(const key of Object.keys(input))if(!allowed.has(key))throw Error('unsupported provider field: '+key);
 if(typeof input.id!=='string'||!ID.test(input.id))throw Error('provider id is invalid');
 if(typeof input.provider!=='string'||!SLUG.test(input.provider))throw Error('provider name must be a lowercase slug');
 if(typeof input.model!=='string'||!input.model.trim()||input.model.length>128)throw Error('model must contain 1..128 characters');
 if(!Array.isArray(input.capabilities)||input.capabilities.length<1||input.capabilities.length>32)throw Error('capabilities must contain 1..32 entries');
 const capabilities=[...new Set(input.capabilities)];
 if(capabilities.some(x=>typeof x!=='string'||!SLUG.test(x)))throw Error('capability names must be lowercase slugs');
 if(input.credentialEnv!==undefined&&input.credentialEnv!==null&&(!
  (typeof input.credentialEnv==='string'&&ENV.test(input.credentialEnv))))throw Error('credentialEnv must be an environment-variable name, never a credential value');
 return {id:input.id,provider:input.provider,model:input.model.trim(),capabilities:capabilities.sort(),credentialEnv:input.credentialEnv||null};
}

class ProviderRegistry{
 constructor(file){
  if(typeof file!=='string'||!file.trim())throw Error('registry file path is required');
  this.file=path.resolve(file);this.providers=[];this.loaded=false;this.opening=null;this.writeQueue=Promise.resolve();
 }
 async open(){
  if(this.loaded)return this;
  if(this.opening)return this.opening;
  this.opening=(async()=>{
   await fs.mkdir(path.dirname(this.file),{recursive:true});
   let parsed;
   try{parsed=JSON.parse(await fs.readFile(this.file,'utf8'))}
   catch(e){if(e.code==='ENOENT'){this.providers=[];this.loaded=true;return this;}throw Error('provider registry is unreadable: '+e.message)}
   if(!parsed||parsed.schema!==SCHEMA||!Array.isArray(parsed.providers))throw Error('provider registry schema is invalid');
   const seen=new Set(),records=[];
   for(const record of parsed.providers){
    const definition=validateProvider(record);
    if(seen.has(definition.id))throw Error('provider registry contains duplicate id: '+definition.id);
    seen.add(definition.id);
    if(!STATES.has(record.status)||!record.createdAt||!record.updatedAt||!Array.isArray(record.evidence))throw Error('provider registry record is invalid: '+definition.id);
    records.push({...definition,status:record.status,createdAt:record.createdAt,updatedAt:record.updatedAt,evidence:clone(record.evidence)});
   }
   this.providers=records;this.loaded=true;return this;
  })().finally(()=>{this.opening=null;});
  return this.opening;
 }
 async _persist(records){
  const temp=this.file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
  let handle;
  try{
   handle=await fs.open(temp,'wx',0o600);
   await handle.writeFile(JSON.stringify({schema:SCHEMA,providers:records},null,2)+'\n','utf8');
   await handle.sync();
   await handle.close();handle=null;
   await fs.rename(temp,this.file);
  }catch(error){
   if(handle)await handle.close().catch(()=>{});
   await fs.unlink(temp).catch(()=>{});
   throw error;
  }
 }
 _mutate(change){
  const operation=this.writeQueue.then(async()=>{
   await this.open();
   const next=clone(this.providers),result=change(next);
   await this._persist(next);
   this.providers=next;
   return clone(result);
  });
  this.writeQueue=operation.catch(()=>{});
  return operation;
 }
 async register(input){
  const definition=validateProvider(input);
  return this._mutate(records=>{
   if(records.some(p=>p.id===definition.id))throw Error('provider already registered: '+definition.id);
   const now=new Date().toISOString();
   const record={...definition,status:'configured',createdAt:now,updatedAt:now,evidence:[]};
   records.push(record);records.sort((a,b)=>a.id.localeCompare(b.id));return record;
  });
 }
 async transition(id,nextState,{evidenceRef=null,reason=null}={}){
  if(!STATES.has(nextState))throw Error('unknown provider state: '+nextState);
  if(['authenticated','smoke-tested','capability-tested'].includes(nextState)&&
     (typeof evidenceRef!=='string'||!evidenceRef.trim()||evidenceRef.length>512))throw Error(nextState+' requires an evidence reference');
  if(['degraded','disabled'].includes(nextState)&&
     (typeof reason!=='string'||!reason.trim()||reason.length>512))throw Error(nextState+' requires a reason');
  return this._mutate(records=>{
   const record=records.find(p=>p.id===id);
   if(!record)throw Error('unknown provider: '+id);
   if(!TRANSITIONS[record.status].has(nextState))throw Error('invalid provider transition: '+record.status+' -> '+nextState);
   const event={state:nextState,at:new Date().toISOString()};
   if(evidenceRef)event.evidenceRef=evidenceRef;
   if(reason)event.reason=reason;
   record.status=nextState;record.updatedAt=event.at;record.evidence.push(event);
   return record;
  });
 }
 async get(id){await this.open();const record=this.providers.find(p=>p.id===id);return record?clone(record):null;}
 async list(){await this.open();return clone(this.providers);}
}
module.exports={ProviderRegistry,PROVIDER_STATES:Object.freeze([...STATES]),PROVIDER_TRANSITIONS:TRANSITIONS,validateProvider};
