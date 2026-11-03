'use strict';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function createPixelMesh({maxPeers=256,staleAfterMs=30000,clock=()=>Date.now()}={}){
 if(!Number.isInteger(maxPeers)||maxPeers<1||maxPeers>4096)throw Error('maxPeers must be 1..4096');
 if(!Number.isFinite(staleAfterMs)||staleAfterMs<1000)throw Error('staleAfterMs must be >=1000');
 const peers=new Map(),edges=new Map();
 function edgeKey(a,b){return [a,b].sort().join('\\0');}
 function getPeer(id){const p=peers.get(id);if(!p)throw Error('unknown peer: '+id);return p;}
 function live(p,now){return p.enabled&&now-p.lastSeen<=staleAfterMs;}
 function neighbors(id,now){return [...edges.values()].filter(e=>e.enabled&&(e.a===id||e.b===id)).map(e=>({edge:e,peer:getPeer(e.a===id?e.b:e.a)})).filter(x=>live(x.peer,now)&&live(getPeer(id),now));}
 function register({peerId,roles=[],capabilities=[],region='local',capacity=1,metadata={}},now=clock()){
  if(typeof peerId!=='string'||!ID.test(peerId))throw Error('peerId is invalid');
  if(!Array.isArray(roles)||roles.some(x=>typeof x!=='string'||!ID.test(x)))throw Error('roles must be valid identifiers');
  if(!Array.isArray(capabilities)||capabilities.some(x=>typeof x!=='string'||!ID.test(x)))throw Error('capabilities must be valid identifiers');
  if(typeof region!=='string'||!region.trim()||region.length>128)throw Error('region is invalid');
  if(!Number.isInteger(capacity)||capacity<1||capacity>256)throw Error('capacity must be 1..256');
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('metadata must be an object');
  if(!peers.has(peerId)&&peers.size>=maxPeers)throw Error('mesh peer limit reached');
  const prior=peers.get(peerId);
  const p={peerId,roles:[...new Set(roles)].sort(),capabilities:[...new Set(capabilities)].sort(),region,capacity,metadata:JSON.parse(JSON.stringify(metadata)),enabled:true,lastSeen:now,registeredAt:prior?prior.registeredAt:now};
  peers.set(peerId,p);return snapshotPeer(p);
 }
 function heartbeat(peerId,{healthy=true,load=0}={},now=clock()){
  const p=getPeer(peerId);if(typeof healthy!=='boolean'||!Number.isFinite(load)||load<0||load>1)throw Error('heartbeat health/load invalid');
  p.enabled=healthy;p.load=load;p.lastSeen=now;return snapshotPeer(p);
 }
 function connect(a,b,{latencyMs=1,cost=0,enabled=true}={}){
  if(a===b)throw Error('self edges are not allowed');getPeer(a);getPeer(b);
  if(!Number.isFinite(latencyMs)||latencyMs<0||!Number.isFinite(cost)||cost<0||typeof enabled!=='boolean')throw Error('edge metrics invalid');
  const key=edgeKey(a,b),edge={a:[a,b].sort()[0],b:[a,b].sort()[1],latencyMs,cost,enabled};
  edges.set(key,edge);return {...edge};
 }
 function snapshotPeer(p){return {...p,roles:[...p.roles],capabilities:[...p.capabilities],metadata:{...p.metadata}};}
 function route({from,to,capability,now=clock(),latencyWeight=1,costWeight=1}){
  getPeer(from);getPeer(to);if(typeof capability!=='string'||!ID.test(capability))throw Error('capability is invalid');
  if(!Number.isFinite(latencyWeight)||latencyWeight<0||!Number.isFinite(costWeight)||costWeight<0)throw Error('route weights invalid');
  if(!live(getPeer(from),now)||!live(getPeer(to),now))return {ok:false,reason:'endpoint_unavailable'};
  if(!getPeer(to).capabilities.includes(capability))return {ok:false,reason:'no_capable_path'};
  const dist=new Map([[from,0]]),prev=new Map(),open=new Set([from]);
  while(open.size){
   let current=null,best=Infinity;for(const id of open){const d=dist.get(id);if(d<best){best=d;current=id;}}
   open.delete(current);if(current===to)break;
   for(const {edge,peer} of neighbors(current,now)){
    const weight=edge.latencyMs*latencyWeight+edge.cost*costWeight;
    const candidate=best+weight;if(candidate<(dist.get(peer.peerId)??Infinity)){dist.set(peer.peerId,candidate);prev.set(peer.peerId,{peerId:current,edge});open.add(peer.peerId);}
   }
  }
  if(!dist.has(to))return {ok:false,reason:'no_capable_path'};
  const path=[to],links=[];let cursor=to;while(cursor!==from){const p=prev.get(cursor);if(!p)return {ok:false,reason:'route_reconstruction_failed'};links.unshift({...p.edge});cursor=p.peerId;path.unshift(cursor);}
  return {ok:true,path,links,score:dist.get(to),capability,computedAt:now};
 }
 function selectWorkers({capability,role=null,limit=8,now=clock(),exclude=[]}){
  if(typeof capability!=='string'||!ID.test(capability))throw Error('capability is invalid');
  if(!Number.isInteger(limit)||limit<1||limit>256)throw Error('limit must be 1..256');
  const blocked=new Set(exclude);return [...peers.values()].filter(p=>live(p,now)&&!blocked.has(p.peerId)&&p.capabilities.includes(capability)&&(!role||p.roles.includes(role))).sort((a,b)=>(a.load??0)-(b.load??0)||a.peerId.localeCompare(b.peerId)).slice(0,limit).map(snapshotPeer);
 }
 function snapshot(now=clock()){return {peerCount:peers.size,livePeers:[...peers.values()].filter(p=>live(p,now)).length,edgeCount:edges.size,peers:[...peers.values()].map(snapshotPeer).sort((a,b)=>a.peerId.localeCompare(b.peerId)),edges:[...edges.values()].map(e=>({...e})).sort((a,b)=>a.a.localeCompare(b.a)||a.b.localeCompare(b.b))};}
 return Object.freeze({register,heartbeat,connect,route,selectWorkers,snapshot});
}
module.exports={createPixelMesh};
