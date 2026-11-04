'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { LiveOrchestratorAdapter } = require('./live-orchestrator-adapter.cjs');
const { ProjectNodeRegistry } = require('./project-node-registry.cjs');

const ROSTER_CONFIG = require('./agent-roster.v1.json');
const ROLES = Object.freeze(ROSTER_CONFIG.agents.map(role => Object.freeze(role)));

const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) :
  Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

const SECRET_CONTENT = [/\bsk-[A-Za-z0-9_-]{20,}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /\bAIza[0-9A-Za-z_-]{30,}\b/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];

class AgentMessageStore {
  constructor(file, { maxEvents = 100000 } = {}) {
    if (typeof file !== 'string' || !file.trim()) throw Error('message ledger path is required');
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000000) throw Error('maxEvents must be 1..1000000');
    this.maxEvents = maxEvents;
    this.file = path.resolve(file);
    this.queue = Promise.resolve();
    this.events = null;
  }
  async open() {
    if (this.events) return this;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let raw;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; raw = ''; }
    const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (events.length > this.maxEvents) throw Error('message ledger exceeds configured event bound');
    let previousHash = '0'.repeat(64);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const body = { sequence: event.sequence, id: event.id, at: event.at, from: event.from,
        to: event.to, conversationId: event.conversationId, kind: event.kind,
        content: event.content, metadata: event.metadata, previousHash: event.previousHash };
      if (event.sequence !== i + 1 || event.previousHash !== previousHash || event.hash !== digest(body)) {
        throw Error('message ledger hash chain invalid at sequence ' + (i + 1));
      }
      previousHash = event.hash;
    }
    this.events = events;
    return this;
  }
  _append(input) {
    const operation = this.queue.then(async () => {
      await this.open();
      if (this.events.length >= this.maxEvents) throw Error('message ledger event bound reached');
      const previousHash = this.events.length ? this.events[this.events.length - 1].hash : '0'.repeat(64);
      const body = { sequence: this.events.length + 1, id: crypto.randomUUID(), at: new Date().toISOString(),
        from: input.from, to: input.to, conversationId: input.conversationId, kind: input.kind,
        content: input.content, metadata: input.metadata || {}, previousHash };
      const event = { ...body, hash: digest(body) };
      const handle = await fs.open(this.file, 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(event) + '\n', 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      this.events.push(event);
      return clone(event);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  appendMessage(input) {
    if (!input || typeof input !== 'object') throw Error('message is required');
    for (const key of ['from', 'to', 'conversationId', 'kind', 'content']) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw Error(key + ' is required');
    }
    if (input.content.length > 12000) throw Error('message exceeds 12000 characters');
    if (SECRET_CONTENT.some(pattern => pattern.test(input.content))) throw Error('message appears to contain a credential; remove it before sending');
    if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata) || Buffer.byteLength(JSON.stringify(input.metadata)) > 4096)) throw Error('message metadata must be a bounded object');
    return this._append(input);
  }
  async thread(conversationId, limit = 100) {
    await this.open();
    return this.events.filter(e => e.conversationId === conversationId).slice(-Math.min(500, Math.max(1, limit))).map(clone);
  }
  async all() { await this.open(); return this.events.map(clone); }
}

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HeavenzFire // Agent Command</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#0b1020;color:#e8edf7}*{box-sizing:border-box}body{margin:0}header{padding:18px 22px;border-bottom:1px solid #29334b;display:flex;justify-content:space-between;align-items:center}header strong{letter-spacing:.14em}main{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - 64px)}aside{border-right:1px solid #29334b;padding:16px}.agent{display:block;width:100%;text-align:left;background:#141d31;color:inherit;border:1px solid #29334b;border-radius:10px;padding:12px;margin:7px 0;cursor:pointer}.agent.active{border-color:#70a5ff;background:#1b2b49}.agent small{display:block;color:#9eacc5;margin-top:4px}.panel{display:flex;flex-direction:column;min-width:0;padding:18px}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.toolbar button,button{background:#284a7e;color:white;border:0;border-radius:8px;padding:10px 14px;cursor:pointer}.toolbar button.secondary{background:#263148}.messages{flex:1;min-height:55vh;max-height:68vh;overflow:auto;border:1px solid #29334b;border-radius:12px;padding:14px;margin:14px 0;background:#0e1628}.msg{padding:10px 12px;margin:9px 0;border-radius:9px;background:#18243a;white-space:pre-wrap;overflow-wrap:anywhere}.msg.user{background:#1d3555}.meta{font-size:12px;color:#9eacc5;margin-bottom:5px}textarea{width:100%;min-height:110px;background:#101a2c;color:inherit;border:1px solid #394865;border-radius:10px;padding:12px;font:inherit}footer{display:grid;gap:10px}.hint{color:#9eacc5;font-size:12px}@media(max-width:720px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #29334b}.agent{width:auto;display:inline-block}.messages{max-height:50vh}}
</style></head><body><header><strong>HEAVENZFIRE // AGENT COMMAND</strong><span id="state">LOCAL SERVICE</span></header><main><aside><h3>Specialists</h3><div id="agents"></div><button id="broadcast" class="secondary">Broadcast to all</button><p class="hint">Each agent has a separate conversation thread. Inference is serialized through the existing orchestrator.</p></aside><section class="panel"><div class="toolbar"><h2 id="title">Coordinator</h2><button id="refresh" class="secondary">Refresh history</button></div><div id="messages" class="messages"></div><footer><textarea id="prompt" placeholder="Give the selected agent an objective…"></textarea><div class="toolbar"><button id="send">Send message</button><span class="hint">Local-first · append-only message journal · approval boundaries unchanged</span></div></footer></section></main>
<script>
const $=id=>document.getElementById(id);let agents=[],selected='planner',broadcast=false;
async function api(url,options){const r=await fetch(url,options);const d=await r.json();if(!r.ok)throw Error(d.error||r.statusText);return d}
function renderAgents(){ $('agents').innerHTML='';for(const a of agents){const b=document.createElement('button');b.className='agent'+(a.id===selected&&!broadcast?' active':'');b.innerHTML='';b.append(document.createTextNode(a.name));const sm=document.createElement('small');sm.textContent=a.voice;b.append(sm);b.onclick=()=>{selected=a.id;broadcast=false;$('title').textContent=a.name;renderAgents();loadThread()};$('agents').append(b)}}
function renderMessages(items){const root=$('messages');root.innerHTML='';for(const e of items){const box=document.createElement('div');box.className='msg '+(e.from==='user'?'user':'');const meta=document.createElement('div');meta.className='meta';meta.textContent=e.from+' → '+e.to+' · '+new Date(e.at).toLocaleString();const body=document.createElement('div');body.textContent=e.content;box.append(meta,body);root.append(box)}root.scrollTop=root.scrollHeight}
async function loadThread(){const id=broadcast?'broadcast':selected;const d=await api('/api/thread/'+encodeURIComponent(id));renderMessages(d.messages)}
async function send(){const content=$('prompt').value.trim();if(!content)return;$('send').disabled=true;$('state').textContent='WORKING';try{const d=await api('/api/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:broadcast?'broadcast':selected,content})});$('prompt').value='';await loadThread();if(d.responses?.length)renderMessages(await api('/api/thread/'+encodeURIComponent(broadcast?'broadcast':selected)).then(x=>x.messages));$('state').textContent='READY'}catch(e){$('state').textContent='ERROR: '+e.message}finally{$('send').disabled=false}}
$('send').onclick=send;$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send()}});$('broadcast').onclick=()=>{broadcast=true;$('title').textContent='Broadcast';renderAgents();loadThread()};$('refresh').onclick=loadThread;
(async()=>{try{agents=(await api('/api/agents')).agents;renderAgents();$('title').textContent='Planner';await loadThread()}catch(e){$('state').textContent='ERROR: '+e.message}})();
</script></body></html>`;

function createCommandCenterServer({ stateDirectory, endpoint = 'http://127.0.0.1:8788/task', roles = ROLES, adapter = null, registry: suppliedRegistry = null, maxMessageEvents = 100000 } = {}) {
  if (!stateDirectory) throw Error('stateDirectory is required');
  if (!Array.isArray(roles) || !roles.length) throw Error('at least one agent role is required');
  const byId = new Map(roles.map(role => [role.id, role]));
  if (byId.size !== roles.length || roles.some(r => !/^[a-z][a-z0-9-]{0,63}$/.test(r.id) || !r.name || !r.system)) {
    throw Error('agent role definitions are invalid or duplicated');
  }
  const store = new AgentMessageStore(path.join(stateDirectory, 'messages.jsonl'), { maxEvents: maxMessageEvents });
  const registry = suppliedRegistry || new ProjectNodeRegistry(path.join(stateDirectory, 'registry'));
  const inference = adapter || new LiveOrchestratorAdapter({ endpoint, maxRetries: ROSTER_CONFIG.execution.retries.transientHttp5xx });
  async function reply(role, prompt, conversationId) {
    const history = await store.thread(conversationId, 12);
    const context = history.map(e => e.from + ': ' + e.content).join('\n');
    const fullPrompt = 'You are ' + role.name + ', specialist role: ' + role.role + '. Voice/style: ' + role.voice +
      '. System instructions: ' + role.system + '\n\nConversation context:\n' + context + '\n\nRespond to the latest user message. Be explicit about uncertainty and evidence.';
    return inference.run({ taskId: 'agent-' + crypto.randomUUID(), role: role.role, prompt: fullPrompt });
  }
  async function readJsonBody(req, maxBytes = 20000) {
    let raw = '', size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) throw Error('request too large');
      raw += chunk;
    }
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('request body must be a JSON object');
    return value;
  }
  async function handle(req, res) {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const hostHeader = req.headers.host;
      let hostUrl;
      try { hostUrl = new URL('http://' + hostHeader); } catch { return send(403, { error: 'loopback_host_required' }); }
      if (!hostHeader || !['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) return send(403, { error: 'loopback_host_required' });
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { return send(403, { error: 'same_origin_required' }); }
        if (origin.protocol !== 'http:' || origin.host !== hostHeader || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
          return send(403, { error: 'same_origin_required' });
        }
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/agents') return send(200, { agents: roles.map(({ id, name, role, voice }) => ({ id, name, role, voice })) });
      if (req.method === 'GET' && url.pathname === '/api/registry') {
        const manifest = await registry.read();
        return send(200, { revision: manifest.revision, projects: manifest.projects, nodes: manifest.nodes, updatedAt: manifest.updatedAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/registry/projects') {
        const input = await readJsonBody(req);
        const project = await registry.registerProject(input, { actor: 'agent-command-center' });
        return send(201, { project });
      }
      if (req.method === 'POST' && url.pathname === '/api/registry/nodes') {
        const input = await readJsonBody(req);
        const node = await registry.upsertNode(input, { actor: 'agent-command-center' });
        return send(201, { node });
      }
      const heartbeatMatch = url.pathname.match(/^\\/api\\/registry\\/nodes\\/([A-Za-z0-9._:-]{1,128})\\/heartbeat$/);
      if (req.method === 'POST' && heartbeatMatch) {
        const input = await readJsonBody(req);
        const node = await registry.recordHeartbeat(decodeURIComponent(heartbeatMatch[1]), input, { actor: 'agent-command-center' });
        return send(200, { node });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/thread/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/thread/'.length));
        return send(200, { messages: await store.thread(id) });
      }
      if (req.method === 'POST' && url.pathname === '/api/message') {
        const input = await readJsonBody(req);
        if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 12000) throw Error('content must be 1..12000 characters');
        const target = input.target;
        if (target === 'broadcast') {
          const broadcastId = 'broadcast';
          await store.appendMessage({ from: 'user', to: 'broadcast', conversationId: broadcastId, kind: 'broadcast', content: input.content });
          const responses = [];
          for (const role of roles) {
            const conversationId = role.id;
            await store.appendMessage({ from: 'user', to: role.id, conversationId, kind: 'broadcast', content: input.content,
              metadata: { broadcastId } });
            try {
              const result = await reply(role, input.content, conversationId);
              const answer = result.response || '(agent returned an empty response)';
              await store.appendMessage({ from: role.id, to: 'user', conversationId, kind: 'response', content: answer,
                metadata: { model: result.model, elapsedMs: result.elapsedMs, broadcastId } });
              await store.appendMessage({ from: role.id, to: 'broadcast', conversationId: broadcastId, kind: 'response', content: answer,
                metadata: { model: result.model, elapsedMs: result.elapsedMs, agentId: role.id } });
              responses.push({ agentId: role.id, status: 'completed', answer });
            } catch (error) {
              responses.push({ agentId: role.id, status: 'failed', error: error.message });
              await store.appendMessage({ from: role.id, to: 'broadcast', conversationId: broadcastId, kind: 'error', content: error.message,
                metadata: { agentId: role.id } });
            }
          }
          return send(200, { responses });
        }
        const role = byId.get(target);
        if (!role) return send(404, { error: 'unknown agent target' });
        await store.appendMessage({ from: 'user', to: role.id, conversationId: role.id, kind: 'direct', content: input.content });
        try {
          const result = await reply(role, input.content, role.id);
          const answer = result.response || '(agent returned an empty response)';
          await store.appendMessage({ from: role.id, to: 'user', conversationId: role.id, kind: 'response', content: answer,
            metadata: { model: result.model, elapsedMs: result.elapsedMs } });
          return send(200, { response: answer, model: result.model, elapsedMs: result.elapsedMs });
        } catch (error) {
          await store.appendMessage({ from: role.id, to: 'user', conversationId: role.id, kind: 'error', content: String(error.message || error).slice(0, 1024),
            metadata: { errorCode: 'agent_inference_failed' } });
          return send(502, { error: 'agent_inference_failed' });
        }
      }
      return send(404, { error: 'not found' });
    } catch (error) { return send(400, { error: error.message }); }
  }
  const server = http.createServer(handle);
  return {
    store,
    registry,
    server,
    async listen({ host = '127.0.0.1', port = 8789 } = {}) {
      if (host !== '127.0.0.1' && host !== '::1') throw Error('Command Center binds to loopback only');
      await store.open();
      await registry.open();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    close() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}

if (require.main === module) {
  const stateDirectory = process.env.HEAVENZFIRE_STATE || path.join(require('node:os').homedir(), '.heavenzfire', 'agent-command-center');
  const endpoint = process.env.HEAVENZFIRE_ORCHESTRATOR_ENDPOINT || 'http://127.0.0.1:8788/task';
  const port = Number(process.env.HEAVENZFIRE_COMMAND_PORT || 8789);
  const app = createCommandCenterServer({ stateDirectory, endpoint });
  app.listen({ host: '127.0.0.1', port }).then(address => {
    process.stdout.write('HeavenzFire Agent Command Center listening at http://127.0.0.1:' + address.port + '\n');
  }).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
module.exports = { AgentMessageStore, createCommandCenterServer, DEFAULT_ROLES: ROLES };
