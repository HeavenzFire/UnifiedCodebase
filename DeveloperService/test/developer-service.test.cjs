'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
const {createLicenseVerifier,canonicalLicensePayload}=require('../license.cjs');
const {reviewRepository}=require('../review-agent.cjs');
const {createDeveloperService,listenLoopback}=require('../server.cjs');
function fixture(features=['code.review']){
 const pair=crypto.generateKeyPairSync('ed25519'),now=Date.now();
 const payload={licenseId:'license-test-001',product:'heavenzfire.developer-service',subject:'customer-test',issuedAt:now-1000,expiresAt:now+60000,features};
 return {pair,payload,envelope:{payload,signature:crypto.sign(null,Buffer.from(canonicalLicensePayload(payload)),pair.privateKey).toString('base64url')},verifier:createLicenseVerifier({publicKey:pair.publicKey})};
}
test('signed license validates; tampering and expiry fail closed',()=>{
 const f=fixture();assert.equal(f.verifier.verify(f.envelope).ok,true);
 const changed=structuredClone(f.envelope);changed.payload.subject='attacker';assert.equal(f.verifier.verify(changed).reason,'license_signature_invalid');
 const expired=fixture();expired.payload.expiresAt=Date.now()-1;expired.envelope.payload.expiresAt=expired.payload.expiresAt;
 expired.envelope.signature=crypto.sign(null,Buffer.from(canonicalLicensePayload(expired.payload)),expired.pair.privateKey).toString('base64url');
 assert.equal(expired.verifier.verify(expired.envelope).reason,'license_expired_or_invalid_time');
});
test('static review detects patterns without returning source snippets',()=>{
 const report=reviewRepository([{path:'src/app.js',content:"const x = eval(input);\n// TODO review\nexecSync('ls');"}]);
 assert.equal(report.filesScanned,1);assert.equal(report.counts.high,1);assert.equal(report.counts.medium,1);assert.equal(report.counts.low,1);
 assert.ok(report.findings.every(x=>!Object.hasOwn(x,'snippet')));
});
test('review rejects traversal, duplicate paths, and oversized files',()=>{
 assert.throws(()=>reviewRepository([{path:'../secret',content:'x'}]),/invalid/);
 assert.throws(()=>reviewRepository([{path:'a.js',content:''},{path:'a.js',content:''}]),/duplicate/);
 assert.throws(()=>reviewRepository([{path:'large.js',content:'x'.repeat(200*1024+1)}]),/size limit/);
});
test('HTTP API enforces auth, license feature, and returns a report',async t=>{
 const f=fixture(),token='test-token-'.padEnd(40,'x'),server=createDeveloperService({licenseVerifier:f.verifier,apiToken:token});
 const address=await listenLoopback(server,{port:0});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=(method,route,body,auth)=>new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port:address.port,method,path:route,headers:{...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...(auth?{authorization:auth}:{})}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
  });req.on('error',reject);if(data)req.write(data);req.end();
 });
 assert.equal((await request('POST','/v1/review',{license:f.envelope,files:[]})).status,401);
 const denied=fixture(['code.read']);assert.equal((await request('POST','/v1/review',{license:denied.envelope,files:[{path:'a.js',content:''}]},'Bearer '+token)).status,403);
 const ok=await request('POST','/v1/review',{license:f.envelope,files:[{path:'a.js',content:'eval(x)'}]},'Bearer '+token);
 assert.equal(ok.status,200);assert.equal(ok.body.report.findingCount,1);assert.equal((await request('GET','/health')).status,200);
});
test('service refuses non-loopback exposure',()=>{
 const f=fixture(),server=createDeveloperService({licenseVerifier:f.verifier,apiToken:'a'.repeat(40)});
 assert.throws(()=>listenLoopback(server,{host:'0.0.0.0'}),/loopback/);
});
