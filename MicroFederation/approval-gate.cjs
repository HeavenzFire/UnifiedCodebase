'use strict';
const crypto=require('node:crypto');
const {createFileApprovalNonceStore}=require('./approval-nonce-store.cjs');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
function createApprovalGate({trustedIssuers={},clock=()=>Date.now(),maxApprovalTtlMs=15*60*1000,nonceStore=null}={}){
 if(!trustedIssuers||typeof trustedIssuers!=='object'||Array.isArray(trustedIssuers))throw Error('trustedIssuers must be a keyed public-key map');
 if(!Number.isInteger(maxApprovalTtlMs)||maxApprovalTtlMs<1000||maxApprovalTtlMs>24*60*60*1000)throw Error('maxApprovalTtlMs is invalid');
 if(nonceStore!==null&&(!nonceStore||typeof nonceStore.consume!=='function'))throw Error('nonceStore must expose a synchronous consume function');
 const usedNonces=new Map();
 function verify({approval,taskId,nodeId,action,subject}={}){
  if(!approval||typeof approval!=='object'||Array.isArray(approval))return {ok:false,reason:'approval_missing'};
  const {version,issuer,approvedTaskId,approvedNodeId,approvedAction,approvedSubject,issuedAt,expiresAt,nonce,signature}=approval;
  if(version!==1||typeof issuer!=='string'||!ID.test(issuer)||typeof nonce!=='string'||!ID.test(nonce)||typeof signature!=='string')return {ok:false,reason:'approval_malformed'};
  if(approvedTaskId!==taskId||approvedNodeId!==nodeId||approvedAction!==action||approvedSubject!==subject)return {ok:false,reason:'approval_scope_mismatch'};
  const now=clock();
  if(!Number.isFinite(issuedAt)||!Number.isFinite(expiresAt)||expiresAt<=now||issuedAt>now+30000||expiresAt-issuedAt>maxApprovalTtlMs)return {ok:false,reason:'approval_expired_or_invalid_time'};
  if(!Object.prototype.hasOwnProperty.call(trustedIssuers,issuer))return {ok:false,reason:'untrusted_approval_issuer'};
  const publicKey=trustedIssuers[issuer];if(!publicKey)return {ok:false,reason:'untrusted_approval_issuer'};
  const unsigned={version,issuer,approvedTaskId,approvedNodeId,approvedAction,approvedSubject,issuedAt,expiresAt,nonce};
  let valid=false;
  try{
   const key=publicKey&&publicKey.type==='public'?publicKey:crypto.createPublicKey(publicKey);
   const algorithm=['ed25519','ed448'].includes(key.asymmetricKeyType)?null:'sha256';
   valid=crypto.verify(algorithm,Buffer.from(canonical(unsigned)),key,Buffer.from(signature,'base64url'));
  }catch{return {ok:false,reason:'approval_signature_invalid'};}
  if(!valid)return {ok:false,reason:'approval_signature_invalid'};
  if(nonceStore){
   try{
    const decision=nonceStore.consume({issuer,nonce,expiresAt,now});
    if(!decision||typeof decision.then==='function')return {ok:false,reason:'approval_replay_store_unavailable'};
    if(decision.ok!==true)return {ok:false,reason:decision.reason||'approval_replay_store_unavailable'};
    return {ok:true,issuer,nonce,expiresAt};
   }catch{return {ok:false,reason:'approval_replay_store_unavailable'};}
  }
  for(const [used,expiry] of usedNonces)if(expiry<=now)usedNonces.delete(used);
  if(usedNonces.has(issuer+':'+nonce))return {ok:false,reason:'approval_replayed'};
  if(usedNonces.size>=100000)return {ok:false,reason:'approval_replay_cache_full'};
  usedNonces.set(issuer+':'+nonce,expiresAt);return {ok:true,issuer,nonce,expiresAt};
 }
 return Object.freeze({verify});
}
module.exports={createApprovalGate,canonicalApprovalPayload:canonical,createFileApprovalNonceStore};
