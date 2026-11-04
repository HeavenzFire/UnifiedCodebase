'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const {reviewRepository}=require('./review-agent.cjs');
const MAX_BODY_BYTES=1200*1024;
function safeEqual(a,b){const x=Buffer.from(a,'utf8'),y=Buffer.from(b,'utf8');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function createDeveloperService({licenseVerifier,apiToken,reviewer=reviewRepository}={}){
 if(!licenseVerifier||typeof licenseVerifier.verify!=='function')throw Error('licenseVerifier.verify is required');
 if(typeof apiToken!=='string'||apiToken.length<32)throw Error('apiToken must contain at least 32 characters');
 if(typeof reviewer!=='function')throw Error('reviewer must be a function');
 return http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');
  const send=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
  if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,service:'heavenzfire-developer-service',version:'0.1.0'});
  if(req.method!=='POST'||req.url!=='/v1/review')return send(404,{ok:false,error:'not_found'});
  const auth=req.headers.authorization||'';if(!auth.startsWith('Bearer ')||!safeEqual(auth.slice(7),apiToken))return send(401,{ok:false,error:'unauthorized'});
  try{
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_BODY_BYTES){send(413,{ok:false,error:'request_too_large'});req.destroy();return;}chunks.push(chunk);}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='files,license')return send(400,{ok:false,error:'request_schema_invalid'});
   const entitlement=licenseVerifier.verify(body.license);if(!entitlement.ok)return send(403,{ok:false,error:'license_denied',reason:entitlement.reason});
   if(!entitlement.features.includes('code.review'))return send(403,{ok:false,error:'feature_not_licensed'});
   return send(200,{ok:true,entitlement:{licenseId:entitlement.licenseId,expiresAt:entitlement.expiresAt},report:reviewer(body.files)});
  }catch(e){return send(400,{ok:false,error:'invalid_request',message:String(e.message||'request rejected').slice(0,240)});}
 });
}
function listenLoopback(server,{port=18796,host='127.0.0.1'}={}){
 if(host!=='127.0.0.1'&&host!=='::1')throw Error('service must bind to loopback; expose only through a separately secured gateway');
 return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve(server.address());});});
}
module.exports={createDeveloperService,listenLoopback,MAX_BODY_BYTES};
