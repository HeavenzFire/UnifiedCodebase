'use strict';
const crypto=require('node:crypto');
const SCHEMA='heavenzfire.developer-license.v1', ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, FEATURE=/^[a-z][a-z0-9._-]{0,63}$/;
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
function createLicenseVerifier({publicKey,productId='heavenzfire.developer-service',clock=()=>Date.now()}={}){
 if(!publicKey)throw Error('license verification public key is required');
 const key=publicKey.type==='public'?publicKey:crypto.createPublicKey(publicKey);
 if(key.asymmetricKeyType!=='ed25519')throw Error('license key must be Ed25519');
 if(typeof productId!=='string'||!ID.test(productId))throw Error('productId is invalid');
 function verify(envelope){try{
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).sort().join(',')!=='payload,signature')return {ok:false,reason:'license_envelope_invalid'};
  const {payload,signature}=envelope;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='expiresAt,features,issuedAt,licenseId,product,subject')return {ok:false,reason:'license_payload_invalid'};
  if(payload.product!==productId||typeof payload.licenseId!=='string'||!ID.test(payload.licenseId)||typeof payload.subject!=='string'||!ID.test(payload.subject)||!Number.isFinite(payload.issuedAt)||!Number.isFinite(payload.expiresAt)||!Array.isArray(payload.features)||payload.features.length<1||payload.features.length>32||payload.features.some(x=>typeof x!=='string'||!FEATURE.test(x))||new Set(payload.features).size!==payload.features.length)return {ok:false,reason:'license_claims_invalid'};
  if(typeof signature!=='string'||! /^[A-Za-z0-9_-]+$/.test(signature)||signature.length>512)return {ok:false,reason:'license_signature_invalid'};
  const bytes=Buffer.from(signature,'base64url');
  if(!bytes.length||bytes.toString('base64url')!==signature||!crypto.verify(null,Buffer.from(canonical(payload)),key,bytes))return {ok:false,reason:'license_signature_invalid'};
  const now=clock();if(!Number.isFinite(now)||payload.issuedAt>now+300000||payload.expiresAt<=now||payload.expiresAt<=payload.issuedAt)return {ok:false,reason:'license_expired_or_invalid_time'};
  return {ok:true,licenseId:payload.licenseId,subject:payload.subject,product:payload.product,features:[...payload.features].sort(),expiresAt:payload.expiresAt};
 }catch{return {ok:false,reason:'license_verification_failed'};}}
 return Object.freeze({verify});
}
module.exports={createLicenseVerifier,canonicalLicensePayload:canonical,LICENSE_SCHEMA:SCHEMA};
