'use strict';
const path=require('node:path');
const MAX_FILES=50,MAX_FILE_BYTES=200*1024,MAX_TOTAL_BYTES=1024*1024;
const SAFE_PATH=/^(?!\/)(?![A-Za-z]:)[A-Za-z0-9._/-]{1,240}$/;
const RULES=[
{id:'HFSEC001',severity:'high',title:'Possible hard-coded credential',pattern:/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*['"][^'"\r\n]{8,}['"]/ig},
{id:'HFSEC002',severity:'high',title:'Dynamic code evaluation',pattern:/\beval\s*\(|\bnew\s+Function\s*\(/g},
{id:'HFSEC003',severity:'medium',title:'Process execution API',pattern:/\b(?:exec|execSync|spawn|spawnSync)\s*\(/g},
{id:'HFMAINT001',severity:'low',title:'Unresolved TODO or FIXME marker',pattern:/\b(?:TODO|FIXME)\b/g}
];
function validateFiles(files){
 if(!Array.isArray(files)||files.length<1||files.length>MAX_FILES)throw Error('files must contain 1..'+MAX_FILES+' entries');
 const seen=new Set();let total=0;
 return files.map((f,i)=>{
  if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).sort().join(',')!=='content,path'||typeof f.path!=='string'||!SAFE_PATH.test(f.path)||f.path.split('/').some(p=>p==='.'||p==='..')||path.posix.normalize(f.path)!==f.path||typeof f.content!=='string')throw Error('file entry '+i+' is invalid');
  if(seen.has(f.path))throw Error('duplicate file path: '+f.path);seen.add(f.path);
  const bytes=Buffer.byteLength(f.content,'utf8');if(bytes>MAX_FILE_BYTES)throw Error('file exceeds per-file size limit: '+f.path);
  total+=bytes;if(total>MAX_TOTAL_BYTES)throw Error('repository input exceeds total size limit');return {path:f.path,content:f.content};
 });
}
function reviewRepository(files){
 const validated=validateFiles(files),findings=[];
 for(const f of validated)for(const rule of RULES){rule.pattern.lastIndex=0;let m;while((m=rule.pattern.exec(f.content))!==null){findings.push({ruleId:rule.id,severity:rule.severity,title:rule.title,path:f.path,line:f.content.slice(0,m.index).split('\n').length,evidence:'Matched static pattern; manual review required.'});if(!rule.pattern.global)break;}}
 findings.sort((a,b)=>a.path.localeCompare(b.path)||a.line-b.line||a.ruleId.localeCompare(b.ruleId));
 const counts={high:0,medium:0,low:0};for(const f of findings)counts[f.severity]++;
 return {schema:'heavenzfire.developer-review.v1',analyzer:'heavenzfire-static-review/0.1.0',filesScanned:validated.length,bytesScanned:validated.reduce((n,f)=>n+Buffer.byteLength(f.content,'utf8'),0),findingCount:findings.length,counts,findings,limitations:['Static pattern checks only; findings may be false positives or false negatives.','No source code is executed and no external network requests are made.','Not a substitute for human review, dependency scanning, or a full security assessment.']};
}
module.exports={reviewRepository,validateFiles,MAX_FILES,MAX_FILE_BYTES,MAX_TOTAL_BYTES};
