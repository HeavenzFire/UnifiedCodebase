'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createPixelMesh}=require('./pixel-mesh.cjs');
test('registers peers, selects least-loaded capable workers and routes across mesh',()=>{
 let now=1000;const m=createPixelMesh({clock:()=>now,staleAfterMs:5000});
 m.register({peerId:'a',capabilities:['build'],roles:['builder']});m.register({peerId:'b',capabilities:['build'],roles:['builder']});m.register({peerId:'c',capabilities:['verify'],roles:['verifier']});
 m.heartbeat('a',{load:.8});m.heartbeat('b',{load:.2});m.connect('a','b',{latencyMs:4});m.connect('b','c',{latencyMs:3});
 assert.deepEqual(m.selectWorkers({capability:'build',role:'builder'}).map(p=>p.peerId),['b','a']);
 assert.deepEqual(m.route({from:'a',to:'c',capability:'verify'}).path,['a','b','c']);
});
test('fails closed for stale peers, unavailable links and missing capabilities',()=>{
 let now=0;const m=createPixelMesh({clock:()=>now,staleAfterMs:1000});m.register({peerId:'a',capabilities:['x']});m.register({peerId:'b',capabilities:['x']});m.connect('a','b');
 assert.equal(m.route({from:'a',to:'b',capability:'x'}).ok,true);
 now=1001;assert.equal(m.route({from:'a',to:'b',capability:'x'}).reason,'endpoint_unavailable');
 now=0;assert.equal(m.route({from:'a',to:'b',capability:'missing'}).reason,'no_capable_path');
});
test('enforces peer and capacity limits and rejects invalid edges',()=>{
 const m=createPixelMesh({maxPeers:1});m.register({peerId:'a'});assert.throws(()=>m.register({peerId:'b'}),/limit/);assert.throws(()=>m.connect('a','a'),/self edges/);assert.throws(()=>m.heartbeat('a',{load:2}),/heartbeat/);
});

test('worker selection scans the full configured peer bound beyond the former 256 cap',()=>{
 const m=createPixelMesh({maxPeers:300});for(let i=0;i<300;i++)m.register({peerId:'peer-'+String(i).padStart(3,'0'),capabilities:['build']});
 assert.equal(m.selectWorkers({capability:'build',limit:4096}).length,300);
});
