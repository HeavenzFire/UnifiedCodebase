'use strict';

const crypto = require('node:crypto');
const VALID_KINDS = new Set(['defect','feature']);
const VALID_STATES = new Set(['discovered','triaged','planned','implementing','testing','verifying','verified','instantiated','blocked']);
const TRANSITIONS = Object.freeze({
  discovered:['triaged','blocked'], triaged:['planned','blocked'], planned:['implementing','blocked'],
  implementing:['testing','blocked'], testing:['verifying','implementing','blocked'],
  verifying:['verified','implementing','blocked'], verified:['instantiated','blocked'],
  instantiated:[], blocked:['triaged']
});
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function assertText(v,name){if(typeof v!=='string'||!v.trim())throw Error(name+' is required');}
function validateWorkItem(item){
  if(!item||typeof item!=='object')throw Error('work item must be an object');
  assertText(item.id,'id'); assertText(item.title,'title');
  if(!VALID_KINDS.has(item.kind))throw Error('kind must be defect or feature');
  if(!Array.isArray(item.acceptanceCriteria)||item.acceptanceCriteria.length===0||item.acceptanceCriteria.some(x=>typeof x!=='string'||!x.trim()))throw Error('explicit acceptance criteria are required');
  if(!Array.isArray(item.targets)||item.targets.length===0||item.targets.some(x=>typeof x!=='string'||!x.trim()))throw Error('at least one target is required');
  return {...item,id:item.id.trim(),title:item.title.trim(),acceptanceCriteria:[...new Set(item.acceptanceCriteria.map(x=>x.trim()))],targets:[...new Set(item.targets.map(x=>x.trim()))]};
}
class EngineeringControlPlane {
  constructor({inventory,scanner,triager,planner,implementer,tester,verifier,ledger,concurrency=1}={}){
    for(const [o,k,n] of [[inventory,'list','inventory'],[scanner,'scan','scanner'],[triager,'triage','triager'],[planner,'plan','planner'],[implementer,'implement','implementer'],[tester,'test','tester'],[verifier,'verify','verifier'],[ledger,'append','ledger']]){
      if(!o||typeof o[k]!=='function')throw Error(n+'.'+k+' adapter required');
    }
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('concurrency must be 1..4');
    Object.assign(this,{inventory,scanner,triager,planner,implementer,tester,verifier,ledger,concurrency});
    this.running=false; this.inFlight=new Set();
  }
  async cycle(){
    if(this.running)throw Error('control-plane cycle already running');
    this.running=true;
    const report={startedAt:new Date().toISOString(),targets:0,discovered:0,verified:0,instantiated:0,blocked:0,errors:[]};
    try{
      const targets=await this.inventory.list(); if(!Array.isArray(targets))throw Error('inventory.list must return an array');
      report.targets=targets.length;
      for(const target of targets){
        try{
          const findings=await this.scanner.scan(target);
          if(!Array.isArray(findings))throw Error('scanner must return findings array');
          for(const raw of findings){
            const item=validateWorkItem(raw); report.discovered++;
            await this.ledger.append(item.id,'discovered',{kind:item.kind,target:item.targets});
            const triage=await this.triager.triage(item);
            if(!triage||!['actionable','duplicate','not_a_defect','needs_human'].includes(triage.disposition))throw Error('triage disposition invalid');
            if(triage.disposition!=='actionable'){
              report.blocked++; await this.ledger.append(item.id,'blocked',{reason:triage.disposition,detail:triage.reason||''}); continue;
            }
            const plan=await this.planner.plan(item,triage);
            if(!plan||!Array.isArray(plan.steps)||!plan.steps.length||!Array.isArray(plan.testCommands)||!plan.testCommands.length)throw Error('plan must include implementation steps and test commands');
            await this.ledger.append(item.id,'planned',{steps:plan.steps,testCommands:plan.testCommands});
            const patch=await this.implementer.implement(item,plan);
            if(!patch||patch.applied!==true||!patch.workspaceId)throw Error('implementer did not confirm an isolated applied patch');
            await this.ledger.append(item.id,'implementing',{workspaceId:patch.workspaceId,changedFiles:patch.changedFiles||[]});
            const tests=await this.tester.test(item,plan,patch);
            if(!tests||tests.passed!==true||!Array.isArray(tests.evidence)||!tests.evidence.length){
              report.blocked++; await this.ledger.append(item.id,'blocked',{reason:'tests_failed',tests:tests||null}); continue;
            }
            await this.ledger.append(item.id,'testing',{evidence:tests.evidence,commands:tests.commands||plan.testCommands});
            const verification=await this.verifier.verify(item,plan,patch,tests);
            if(!verification||verification.passed!==true||!Array.isArray(verification.evidence)||!verification.evidence.length){
              report.blocked++; await this.ledger.append(item.id,'blocked',{reason:'independent_verification_failed'}); continue;
            }
            report.verified++; await this.ledger.append(item.id,'verified',{evidence:verification.evidence});
            if(item.kind==='feature'){
              if(!Array.isArray(item.acceptanceCriteria)||!item.acceptanceCriteria.length)throw Error('feature acceptance criteria missing');
              const acceptance=await this.verifier.verify({...item,verificationMode:'feature_acceptance'},plan,patch,{...tests,acceptanceCriteria:item.acceptanceCriteria});
              if(!acceptance||acceptance.passed!==true||!Array.isArray(acceptance.evidence)||!acceptance.evidence.length){
                report.blocked++; await this.ledger.append(item.id,'blocked',{reason:'feature_acceptance_not_met'}); continue;
              }
              report.instantiated++; await this.ledger.append(item.id,'instantiated',{acceptanceEvidence:acceptance.evidence,workspaceId:patch.workspaceId});
            }
          }
        }catch(error){report.errors.push({target:String(target.id||target.name||'unknown'),error:String(error.message||error)});}
      }
      report.finishedAt=new Date().toISOString(); return report;
    }finally{this.running=false;}
  }
}
module.exports={EngineeringControlPlane,validateWorkItem,VALID_STATES,TRANSITIONS,sha};
