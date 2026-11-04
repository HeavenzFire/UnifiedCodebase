'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {IssueRemediationPipeline,RemediationLedger,ROLE_IDS}=require('./issue-remediation-pipeline.cjs');
async function fixture(t,overrides={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hf-remediation-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const calls={agents:[],pr:[],tests:[],verification:[]};
 const adapters={
  intake:{async getIssue(id){return {id,componentId:1400036,title:'Broken documentation example',description:'Example does not run',url:'https://issuetracker.google.com/issues/'+id};}},
  sourceResolver:{async resolve(){return {repository:'HeavenzFire/docs-mirror',baseBranch:'main',evidence:['maintained source mapping fixture']};}},
  agentRunner:{async run(roleId,task){calls.agents.push(roleId);return roleId==='synthesizer'&&task.reviews?{patch:'diff --git a/docs.md b/docs.md\n'}:{findings:'Reviewed source evidence for '+roleId,verdict:'inconclusive'};}},
  patcher:{async createWorkspace(){return {id:'isolated-issue-workspace'};},async applyPatch(){return {applied:true,patchId:'patch-1',changedFiles:['docs.md']};}},
  testRunner:{async run(){calls.tests.push(1);return {passed:true,commands:['npm test'],evidence:['test log sha256:abc']};}},
  verifier:{async verify(){calls.verification.push(1);return {passed:true,evidence:['independent diff review','regression output sha256:def']};}},
  pullRequests:{async createDraft(input){calls.pr.push(input);return {draft:true,url:'https://github.com/HeavenzFire/docs-mirror/pull/7',number:7};}}
 };
 Object.assign(adapters,overrides);
 return {pipeline:new IssueRemediationPipeline({ledgerFile:path.join(dir,'ledger.jsonl'),...adapters,allowedRepositories:['HeavenzFire/docs-mirror']}),calls,dir};
}
test('16-role repair flow creates draft PR only after tests and independent verification',async t=>{
 const {pipeline,calls}=await fixture(t); const r=await pipeline.process('123456');
 assert.equal(r.status,'draft_pr_created'); assert.equal(r.agentReviews,16);
 assert.equal(calls.agents.filter(x=>ROLE_IDS.includes(x)).length,17);
 assert.equal(calls.tests.length,1); assert.equal(calls.verification.length,1); assert.equal(calls.pr.length,1); assert.equal(calls.pr[0].draft,true);
});
test('blocks repository outside explicit allowlist',async t=>{
 const {pipeline,calls}=await fixture(t,{sourceResolver:{async resolve(){return {repository:'GoogleChrome/developer.chrome.com',baseBranch:'main'};}}});
 const r=await pipeline.process('123457'); assert.equal(r.status,'blocked'); assert.equal(calls.agents.length,0); assert.equal(calls.pr.length,0);
});
test('never creates PR when tests fail',async t=>{
 const {pipeline,calls}=await fixture(t,{testRunner:{async run(){return {passed:false,commands:['npm test'],evidence:['failure']};}}});
 const r=await pipeline.process('123458'); assert.equal(r.reason,'tests_not_passed'); assert.equal(calls.pr.length,0);
});
test('never creates PR without independent verification evidence',async t=>{
 const {pipeline,calls}=await fixture(t,{verifier:{async verify(){return {passed:false,evidence:[]};}}});
 const r=await pipeline.process('123459'); assert.equal(r.reason,'independent_verification_failed'); assert.equal(calls.pr.length,0);
});
test('rejects issues outside component and malformed IDs',async t=>{
 const {pipeline}=await fixture(t,{intake:{async getIssue(id){return {id,componentId:166797,title:'Wrong component'};}}});
 await assert.rejects(pipeline.process('123460'),/outside the configured/); await assert.rejects(pipeline.process('../escape'),/numeric/);
});
test('ledger detects tampering',async t=>{
 const {dir}=await fixture(t), file=path.join(dir,'tamper.jsonl'), ledger=await new RemediationLedger(file).open();
 await ledger.append('123461','issue_loaded',{title:'test'}); await ledger.append('123461','blocked',{reason:'test'});
 const rows=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse); assert.equal(rows[1].previous,rows[0].hash);
 rows[0].data.title='tampered'; await fs.writeFile(file,rows.map(JSON.stringify).join('\n')+'\n');
 await assert.rejects(new RemediationLedger(file).open(),/hash chain invalid/);
});

test('Command Center agent runner reuses the existing serialized orchestrator adapter',async()=>{
 const {createCommandCenterAgentRunner}=require('./issue-remediation-pipeline.cjs');
 const calls=[];
 const runner=createCommandCenterAgentRunner({adapter:{async run(input){calls.push(input);return {response:input.role==='Synthesizer'?JSON.stringify({findings:'consensus',verdict:'pass',patch:'diff --git a/a b/a'}):'source-backed finding'};}},roles:require('./agent-roster.v1.json').agents});
 const review=await runner.run('security-reviewer',{issue:{id:'1'},source:{repository:'owner/repo'},instruction:'review'});
 assert.match(review.findings,/source-backed/);
 const synthesis=await runner.run('synthesizer',{issue:{id:'1'},source:{repository:'owner/repo'},reviews:[review],instruction:'synthesize'});
 assert.equal(synthesis.patch,'diff --git a/a b/a');
 assert.equal(calls.length,2);
});
