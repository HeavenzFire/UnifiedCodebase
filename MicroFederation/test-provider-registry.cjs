'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ProviderRegistry,PROVIDER_STATES}=require('./provider-registry.cjs');

async function registryFile(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-provider-registry-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return path.join(dir,'providers.json');
}
test('provider registry persists provider state across restart without storing credentials',async t=>{
 const file=await registryFile(t),registry=await new ProviderRegistry(file).open();
 await registry.register({id:'gemini-main',provider:'gemini',model:'gemini-model',capabilities:['chat','vision'],credentialEnv:'GEMINI_API_KEY'});
 await registry.transition('gemini-main','authenticated',{evidenceRef:'local-check:credential-present'});
 await registry.transition('gemini-main','smoke-tested',{evidenceRef:'test-run:smoke-001'});
 const restarted=await new ProviderRegistry(file).open(),record=await restarted.get('gemini-main');
 assert.equal(record.status,'smoke-tested');
 assert.deepEqual(record.capabilities,['chat','vision']);
 assert.equal(record.credentialEnv,'GEMINI_API_KEY');
 const persisted=await fs.readFile(file,'utf8');
 assert.equal(persisted.includes('sk-secret-value'),false);
 assert.equal(PROVIDER_STATES.includes('capability-tested'),true);
});
test('provider registry rejects raw secret fields and invalid credential references',async t=>{
 const registry=await new ProviderRegistry(await registryFile(t)).open();
 await assert.rejects(registry.register({id:'bad',provider:'gemini',model:'m',capabilities:['chat'],apiKey:'sk-secret-value'}),/unsupported provider field/);
 await assert.rejects(registry.register({id:'bad',provider:'gemini',model:'m',capabilities:['chat'],credentialEnv:'sk-secret-value'}),/environment-variable name/);
 assert.equal((await registry.list()).length,0);
});
test('provider lifecycle requires evidence and rejects skipped states',async t=>{
 const registry=await new ProviderRegistry(await registryFile(t)).open();
 await registry.register({id:'mistral-main',provider:'mistral',model:'mistral-model',capabilities:['chat']});
 await assert.rejects(registry.transition('mistral-main','smoke-tested',{evidenceRef:'run:1'}),/invalid provider transition/);
 await assert.rejects(registry.transition('mistral-main','authenticated'),/requires an evidence reference/);
 await registry.transition('mistral-main','authenticated',{evidenceRef:'credential-check:1'});
 await registry.transition('mistral-main','smoke-tested',{evidenceRef:'smoke:1'});
 await registry.transition('mistral-main','capability-tested',{evidenceRef:'capability:1'});
 assert.equal((await registry.get('mistral-main')).status,'capability-tested');
 await assert.rejects(registry.transition('mistral-main','smoke-tested',{evidenceRef:'smoke:2'}),/invalid provider transition/);
});
test('provider registry serializes concurrent registrations and preserves unique ids',async t=>{
 const registry=await new ProviderRegistry(await registryFile(t)).open();
 const input={id:'qwen-local',provider:'qwen',model:'qwen-local',capabilities:['chat']};
 const outcomes=await Promise.allSettled([registry.register(input),registry.register(input)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
 assert.equal((await registry.list()).length,1);
});
test('degraded and disabled providers require reasons and can be explicitly reconfigured',async t=>{
 const registry=await new ProviderRegistry(await registryFile(t)).open();
 await registry.register({id:'monica-main',provider:'monica',model:'monica-model',capabilities:['chat']});
 await assert.rejects(registry.transition('monica-main','degraded'),/requires a reason/);
 await registry.transition('monica-main','degraded',{reason:'provider quota unavailable'});
 await registry.transition('monica-main','configured');
 await registry.transition('monica-main','disabled',{reason:'operator disabled'});
 assert.equal((await registry.get('monica-main')).status,'disabled');
});
test('provider registry rejects corrupted persisted schema',async t=>{
 const file=await registryFile(t);await fs.writeFile(file,JSON.stringify({schema:'wrong',providers:[]}));
 await assert.rejects(new ProviderRegistry(file).open(),/schema is invalid/);
});
