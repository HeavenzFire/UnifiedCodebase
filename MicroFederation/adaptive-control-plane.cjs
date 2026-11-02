'use strict';

/*
 * HeavenzFire Adaptive Control Plane
 * Node.js 18+; opt-in integration layer for the existing MicroFederation.
 * No service starts on import. No credentials are read from agent payloads.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SCHEMA = 'heavenzfire.adaptive-control-plane.v1';
const HIGH_IMPACT = new Set([
  'repo.merge', 'deploy', 'credential.write', 'network.expose',
  'command.privileged', 'database.drop', 'filesystem.delete',
  'financial.transaction', 'production.write'
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256')
  .update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value))
  .digest('hex');
const iso = value => new Date(value).toISOString();

function safeJson(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw Error(label + ' must be JSON serializable'); }
  if (encoded === undefined) throw Error(label + ' must be JSON serializable');
  return JSON.parse(encoded);
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function execCapture(command, args, timeoutMs = 2500) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, stderr: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => finish({ ok: false, stdout, stderr: error.message }));
    child.on('close', code => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

async function collectTelemetry({ providerTelemetry = {}, reservedMemoryMb = 512 } = {}) {
  const totalMemoryMb = Math.floor(os.totalmem() / 1048576);
  const availableMemoryMb = Math.floor(os.freemem() / 1048576);
  const cpuCount = Math.max(1, os.cpus().length);
  const load = os.loadavg();
  let gpu = { available: false, devices: [], reason: 'nvidia-smi unavailable' };
  const nv = await execCapture('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.free,utilization.gpu',
    '--format=csv,noheader,nounits'
  ]);
  if (nv.ok) {
    const devices = nv.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const parts = line.split(',').map(x => x.trim());
      return {
        index: Number(parts[0]),
        name: parts[1],
        totalMb: Number(parts[2]),
        freeMb: Number(parts[3]),
        utilizationPct: Number(parts[4])
      };
    }).filter(x => Number.isFinite(x.freeMb));
    gpu = { available: devices.length > 0, devices, reason: devices.length ? null : 'no NVIDIA devices reported' };
  }
  let disk = null;
  if (typeof fs.statfs === 'function') {
    try {
      const stats = await fs.statfs(process.cwd());
      disk = { totalMb: Math.floor(Number(stats.blocks * stats.bsize) / 1048576),
        availableMb: Math.floor(Number(stats.bavail * stats.bsize) / 1048576) };
    } catch { disk = null; }
  }
  const sockets = await execCapture(process.platform === 'win32' ? 'netstat' : 'sh',
    process.platform === 'win32' ? ['-an'] : ['-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l']);
  const socketCount = sockets.ok
    ? process.platform === 'win32'
      ? sockets.stdout.split(/\r?\n/).filter(line => /\b(TCP|UDP)\b/i.test(line)).length
      : Math.max(0, Number.parseInt(sockets.stdout.trim(), 10) - 2)
    : null;
  const providers = Object.entries(providerTelemetry || {}).map(([id, state]) => ({
    id,
    available: state && state.available === true,
    remainingRequests: Number.isFinite(state && state.remainingRequests) ? state.remainingRequests : null,
    resetAt: state && state.resetAt || null,
    reason: state && state.reason || null
  }));
  return {
    schema: 'heavenzfire.resource-telemetry.v1',
    capturedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, release: os.release(), cpuCount, loadAverage: load },
    memory: { totalMb: totalMemoryMb, availableMb: availableMemoryMb, reservedMb: reservedMemoryMb },
    gpu,
    disk,
    network: { activeSocketCount: socketCount },
    providers
  };
}

function deriveCapacity(snapshot, profiles = {}) {
  const memoryReserve = Math.max(128, Number(snapshot.memory.reservedMb) || 512);
  const freeMemory = Math.max(0, Number(snapshot.memory.availableMb) - memoryReserve);
  const cpuAvailable = Math.max(0, Number(snapshot.host.cpuCount) - 1);
  const providerSlots = snapshot.providers.length
    ? snapshot.providers.filter(p => p.available && (p.remainingRequests === null || p.remainingRequests > 0)).length
    : Infinity;
  const gpuFree = snapshot.gpu && snapshot.gpu.available
    ? Math.max(...snapshot.gpu.devices.map(d => d.freeMb), 0) : 0;
  const result = {};
  for (const [kind, raw] of Object.entries(profiles)) {
    const profile = {
      memoryMb: Math.max(1, Number(raw.memoryMb) || 256),
      cpuCores: Math.max(0.1, Number(raw.cpuCores) || 0.25),
      gpuMb: Math.max(0, Number(raw.gpuMb) || 0),
      provider: raw.provider || null
    };
    const byMemory = Math.floor(freeMemory / profile.memoryMb);
    const byCpu = Math.floor(cpuAvailable / profile.cpuCores);
    const byGpu = profile.gpuMb > 0 ? Math.floor(gpuFree / profile.gpuMb) : Infinity;
    const provider = profile.provider
      ? snapshot.providers.find(p => p.id === profile.provider)
      : null;
    const byProvider = profile.provider
      ? provider && provider.available
        ? provider.remainingRequests === null ? Infinity : Math.max(0, provider.remainingRequests)
        : 0
      : providerSlots;
    const slots = Math.max(0, Math.floor(Math.min(byMemory, byCpu, byGpu, byProvider)));
    result[kind] = {
      slots,
      constrainedBy: [
        ['memory', byMemory], ['cpu', byCpu], ['gpu', byGpu], ['provider', byProvider]
      ].filter(([, n]) => n === Math.min(byMemory, byCpu, byGpu, byProvider)).map(([name]) => name),
      profile
    };
  }
  return result;
}

class BudgetLedger {
  constructor(file) { this.file = path.resolve(file); this.state = null; this.queue = Promise.resolve(); }
  async open() {
    if (this.state) return this;
    const state = await readJson(this.file, { schema: 'heavenzfire.budget-ledger.v1', budgets: {}, events: [] });
    if (!state || state.schema !== 'heavenzfire.budget-ledger.v1' ||
        !state.budgets || typeof state.budgets !== 'object' || !Array.isArray(state.events)) {
      throw Error('budget ledger schema is invalid');
    }
    this.state = state;
    return this;
  }
  _mutate(fn) {
    const op = this.queue.then(async () => {
      await this.open();
      const next = clone(this.state);
      const result = fn(next);
      next.events.push({ at: new Date().toISOString(), type: result.type, taskId: result.taskId || null,
        resource: result.resource || null, amount: result.amount || 0, balance: result.balance || null });
      await atomicJson(this.file, next);
      this.state = next;
      return clone(result.value);
    });
    this.queue = op.catch(() => {});
    return op;
  }
  async allocate(taskId, amounts) {
    if (!ID.test(taskId || '')) throw Error('taskId is invalid');
    const allowed = ['tokens', 'currencyMicros', 'computeMs', 'networkBytes'];
    for (const key of Object.keys(amounts || {})) {
      if (!allowed.includes(key) || !Number.isFinite(amounts[key]) || amounts[key] < 0) throw Error('invalid budget allocation: ' + key);
    }
    return this._mutate(state => {
      if (state.budgets[taskId]) throw Error('budget already allocated for task');
      const balance = Object.fromEntries(allowed.map(k => [k, Number(amounts[k] || 0)]));
      state.budgets[taskId] = { allocated: clone(balance), remaining: clone(balance), consumed: Object.fromEntries(allowed.map(k => [k, 0])) };
      return { type: 'budget.allocated', taskId, value: state.budgets[taskId] };
    });
  }
  async consume(taskId, resource, amount) {
    if (!ID.test(taskId || '') || !['tokens', 'currencyMicros', 'computeMs', 'networkBytes'].includes(resource) ||
        !Number.isFinite(amount) || amount < 0) throw Error('invalid budget consumption');
    return this._mutate(state => {
      const budget = state.budgets[taskId];
      if (!budget) throw Error('no budget allocated for task');
      if (amount > budget.remaining[resource]) throw Error('budget exhausted: ' + resource);
      budget.remaining[resource] -= amount;
      budget.consumed[resource] += amount;
      return { type: 'budget.consumed', taskId, resource, amount,
        balance: budget.remaining[resource], value: budget };
    });
  }
  async get(taskId) { await this.open(); return this.state.budgets[taskId] ? clone(this.state.budgets[taskId]) : null; }
}

class CandidateRepository {
  constructor(root) {
    this.root = path.resolve(root);
    this.objects = path.join(this.root, 'objects');
    this.indexFile = path.join(this.root, 'index.json');
    this.queue = Promise.resolve();
  }
  async open() {
    await fs.mkdir(this.objects, { recursive: true });
    const index = await readJson(this.indexFile, { schema: 'heavenzfire.candidate-graph.v1', candidates: {}, edges: [], events: [] });
    if (!index || index.schema !== 'heavenzfire.candidate-graph.v1' ||
        !index.candidates || !Array.isArray(index.edges) || !Array.isArray(index.events)) throw Error('candidate graph schema is invalid');
    this.index = index;
    return this;
  }
  _mutate(fn) {
    const op = this.queue.then(async () => {
      if (!this.index) await this.open();
      const next = clone(this.index);
      const value = fn(next);
      await atomicJson(this.indexFile, next);
      this.index = next;
      return clone(value);
    });
    this.queue = op.catch(() => {});
    return op;
  }
  async put(candidate) {
    const safe = safeJson(candidate, 'candidate');
    if (!safe || typeof safe !== 'object' || Array.isArray(safe)) throw Error('candidate must be an object');
    const content = JSON.stringify(safe);
    const digest = sha256(content);
    const objectPath = path.join(this.objects, digest + '.json');
    await fs.mkdir(this.objects, { recursive: true });
    try { await fs.writeFile(objectPath, content + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return this._mutate(index => {
      if (!index.candidates[digest]) {
        const record = {
          id: digest, contentHash: digest, parentIds: Array.isArray(safe.parentIds) ? safe.parentIds : [],
          type: typeof safe.type === 'string' ? safe.type : 'unknown',
          hypothesis: typeof safe.hypothesis === 'string' ? safe.hypothesis : '',
          generation: Number.isInteger(safe.generation) && safe.generation >= 0 ? safe.generation : 0,
          createdAt: new Date().toISOString(), fitness: safe.fitness || null,
          verification: safe.verification || { status: 'unverified' },
          provenance: safe.provenance || null
        };
        index.candidates[digest] = record;
        for (const parentId of record.parentIds) {
          if (!/^[a-f0-9]{64}$/.test(parentId)) throw Error('candidate parent id must be a SHA-256 digest');
          if (!index.candidates[parentId]) throw Error('candidate parent does not exist: ' + parentId);
          index.edges.push({ from: parentId, to: digest, type: 'mutation' });
        }
        index.events.push({ at: record.createdAt, type: 'candidate.created', candidateId: digest });
      }
      return index.candidates[digest];
    });
  }
  async get(id) {
    if (!this.index) await this.open();
    if (!this.index.candidates[id]) return null;
    const content = await fs.readFile(path.join(this.objects, id + '.json'), 'utf8');
    if (sha256(content.trimEnd()) !== id) throw Error('candidate object hash mismatch');
    return { record: clone(this.index.candidates[id]), content: JSON.parse(content) };
  }
  async list() { if (!this.index) await this.open(); return Object.values(this.index.candidates).map(clone); }
  async recordEvaluation(id, evaluation) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('candidate id is invalid');
    const safe = safeJson(evaluation, 'evaluation');
    return this._mutate(index => {
      const record = index.candidates[id];
      if (!record) throw Error('unknown candidate');
      record.fitness = safe.fitness || null;
      record.verification = safe.verification || { status: 'unverified' };
      record.evaluatedAt = new Date().toISOString();
      index.events.push({ at: record.evaluatedAt, type: 'candidate.evaluated', candidateId: id,
        evaluationHash: sha256(JSON.stringify(safe)) });
      return record;
    });
  }
}

class AdaptiveScheduler {
  constructor({ telemetry = collectTelemetry, profiles, refreshMs = 5000 } = {}) {
    if (typeof telemetry !== 'function') throw Error('telemetry must be a function');
    if (!profiles || typeof profiles !== 'object') throw Error('resource profiles are required');
    this.telemetry = telemetry;
    this.profiles = profiles;
    this.refreshMs = refreshMs;
    this.snapshot = null;
    this.capacity = {};
    this.lastRefresh = 0;
    this.active = new Map();
    this.waiters = [];
  }
  async refresh(providerTelemetry) {
    this.snapshot = await this.telemetry({ providerTelemetry });
    this.capacity = deriveCapacity(this.snapshot, this.profiles);
    this.lastRefresh = Date.now();
    this._drain();
    return { snapshot: this.snapshot, capacity: clone(this.capacity) };
  }
  async run(kind, work, { signal, providerTelemetry } = {}) {
    if (typeof work !== 'function') throw Error('work must be a function');
    if (!this.snapshot || Date.now() - this.lastRefresh > this.refreshMs) await this.refresh(providerTelemetry);
    const capacity = this.capacity[kind];
    if (!capacity) throw Error('unknown resource profile: ' + kind);
    if (capacity.slots < 1) throw Error('no current execution capacity for ' + kind);
    return new Promise((resolve, reject) => {
      const item = { kind, work, resolve, reject, signal, cancelled: false };
      if (signal && signal.aborted) return reject(Error('task aborted before scheduling'));
      if (signal) {
        item.abort = () => {
          item.cancelled = true;
          const index = this.waiters.indexOf(item);
          if (index >= 0) { this.waiters.splice(index, 1); reject(Error('task aborted while queued')); }
        };
        signal.addEventListener('abort', item.abort, { once: true });
      }
      this.waiters.push(item);
      this._drain();
    });
  }
  _drain() {
    if (!this.snapshot) return;
    for (let i = 0; i < this.waiters.length;) {
      const item = this.waiters[i];
      const limit = this.capacity[item.kind] ? this.capacity[item.kind].slots : 0;
      const active = this.active.get(item.kind) || 0;
      if (item.cancelled) { this.waiters.splice(i, 1); continue; }
      if (active >= limit) { i++; continue; }
      this.waiters.splice(i, 1);
      if (item.signal && item.abort) item.signal.removeEventListener('abort', item.abort);
      this.active.set(item.kind, active + 1);
      Promise.resolve().then(() => item.work({
        telemetry: this.snapshot,
        profile: clone(this.capacity[item.kind].profile)
      })).then(item.resolve, item.reject).finally(() => {
        this.active.set(item.kind, Math.max(0, (this.active.get(item.kind) || 1) - 1));
        this._drain();
      });
    }
  }
  stats() {
    return { capacity: clone(this.capacity), active: Object.fromEntries(this.active),
      queued: this.waiters.length, capturedAt: this.snapshot && this.snapshot.capturedAt || null };
  }
}

class DockerSandbox {
  constructor({ image, workspaceRoot, timeoutMs = 120000, memoryMb = 512, cpuCores = 1, pidsLimit = 128 } = {}) {
    if (typeof image !== 'string' || !image.trim()) throw Error('a pinned, trusted sandbox image is required');
    if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw Error('sandbox image must be pinned by a full SHA-256 digest');
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw Error('sandbox workspaceRoot is required');
    this.image = image;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.timeoutMs = timeoutMs;
    this.memoryMb = memoryMb;
    this.cpuCores = cpuCores;
    this.pidsLimit = pidsLimit;
  }
  async evaluate({ candidateDirectory, command, args = [], resources = {} }) {
    if (!Array.isArray(command) || command.length !== 1 || typeof command[0] !== 'string' || !command[0].trim()) {
      throw Error('command must be a one-element executable array');
    }
    if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw Error('args must be strings');
    const root = await fs.realpath(candidateDirectory);
    const workspace = await fs.realpath(this.workspaceRoot);
    const relative = path.relative(workspace, root);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw Error('candidateDirectory must be a child of the configured sandbox workspace');
    }
    const info = await fs.stat(root);
    if (!info.isDirectory()) throw Error('candidateDirectory must be a directory');
    const memoryMb = Number.isFinite(resources.memoryMb) && resources.memoryMb > 0 ? Math.floor(resources.memoryMb) : this.memoryMb;
    const cpuCores = Number.isFinite(resources.cpuCores) && resources.cpuCores > 0 ? resources.cpuCores : this.cpuCores;
    const dockerArgs = [
      'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--user=65532:65532',
      '--pids-limit=' + this.pidsLimit, '--memory=' + memoryMb + 'm',
      '--memory-swap=' + memoryMb + 'm', '--cpus=' + cpuCores,
      '--ulimit', 'nofile=1024:1024', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', 'type=bind,src=' + root + ',dst=/candidate,readonly',
      '--workdir', '/candidate', this.image, command[0], ...args
    ];
    const started = Date.now();
    const result = await execCapture('docker', dockerArgs, this.timeoutMs);
    return { ok: result.ok, exitCode: result.code === undefined ? null : result.code,
      stdout: result.stdout.slice(0, 20000), stderr: result.stderr.slice(0, 10000),
      elapsedMs: Date.now() - started, sandbox: 'docker-isolated-network-disabled-readonly-rootfs' };
  }
}


class CredentialBroker {
  constructor({ providers, fetchImpl = globalThis.fetch } = {}) {
    if (!providers || typeof providers !== 'object' || typeof fetchImpl !== 'function') {
      throw Error('provider definitions and fetch implementation are required');
    }
    this.providers = new Map();
    this.fetchImpl = fetchImpl;
    for (const [id, raw] of Object.entries(providers)) {
      if (!ID.test(id) || !raw || typeof raw !== 'object') throw Error('credential provider definition is invalid');
      const base = new URL(raw.baseUrl);
      if (base.protocol !== 'https:' || base.username || base.password) throw Error('credential broker requires an HTTPS origin without embedded credentials');
      if (typeof raw.credentialEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(raw.credentialEnv)) throw Error('credentialEnv must be an environment-variable name');
      const headerName = raw.headerName || 'authorization';
      if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) throw Error('credential header name is invalid');
      if (!Array.isArray(raw.allowedPaths) || raw.allowedPaths.length < 1 ||
          raw.allowedPaths.some(p => typeof p !== 'string' || !p.startsWith('/') || p.includes('..'))) {
        throw Error('provider must declare explicit allowedPaths');
      }
      this.providers.set(id, { baseUrl: base.toString().replace(/\/?$/, '/'),
        credentialEnv: raw.credentialEnv, headerName, prefix: raw.prefix || 'Bearer ',
        allowedPaths: raw.allowedPaths.slice() });
    }
  }
  async request({ providerId, path: requestPath, method = 'GET', body = undefined } = {}) {
    const provider = this.providers.get(providerId);
    if (!provider) throw Error('unknown credential provider');
    if (typeof requestPath !== 'string' || !requestPath.startsWith('/') ||
        requestPath.startsWith('//') || requestPath.includes('\\') || requestPath.includes('#')) {
      throw Error('request path is invalid');
    }
    if (!['GET', 'POST'].includes(method)) throw Error('credential broker method is not permitted');
    const rawPath = requestPath.split('?')[0];
    // Encoded separators can be interpreted differently by upstream servers;
    // reject them rather than allowing a second path parser to widen the route.
    if (!rawPath || /%(?:2f|5c)/i.test(rawPath)) throw Error('request path is invalid');
    const url = new URL(requestPath.slice(1), provider.baseUrl);
    if (url.origin !== new URL(provider.baseUrl).origin || url.protocol !== 'https:') throw Error('credential broker URL escaped its provider origin');
    // WHATWG URL parsing removes literal and percent-encoded dot segments.
    // Require the raw path to survive normalization unchanged, then authorize
    // the normalized pathname (never the untrusted input string).
    if (url.pathname !== rawPath) throw Error('request path is invalid after URL normalization');
    if (!provider.allowedPaths.some(prefix => url.pathname === prefix ||
        url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))) {
      throw Error('request path is not allowlisted');
    }
    const secret = process.env[provider.credentialEnv];
    if (!secret) throw Error('provider credential is not configured in the broker environment');
    const headers = { accept: 'application/json', [provider.headerName]: provider.prefix + secret };
    let encodedBody;
    if (body !== undefined) {
      encodedBody = JSON.stringify(safeJson(body, 'provider request body'));
      headers['content-type'] = 'application/json';
    }
    const response = await this.fetchImpl(url, {
      method, headers, body: encodedBody, redirect: 'error',
      signal: AbortSignal.timeout(30000)
    });
    let text = await response.text();
    text = text.split(secret).join('[REDACTED]');
    return { ok: response.ok, status: response.status, body: text.slice(0, 50000),
      providerId, requestPath };
  }
}

class CapabilityGate {
  constructor({ capabilityStore, approvalVerifier }) {
    if (!capabilityStore || typeof capabilityStore.authorize !== 'function') throw Error('existing CapabilityStore is required');
    if (typeof approvalVerifier !== 'function') throw Error('trusted approvalVerifier is required');
    this.store = capabilityStore;
    this.approvalVerifier = approvalVerifier;
  }
  async authorize(request) {
    if (!request || typeof request.agentId !== 'string' || typeof request.capability !== 'string' ||
        typeof request.action !== 'string') throw Error('agentId, capability and action are required');
    const highImpact = HIGH_IMPACT.has(request.capability) || HIGH_IMPACT.has(request.action);
    let attestation = null;
    if (highImpact) {
      attestation = await this.approvalVerifier({
        agentId: request.agentId, taskId: request.taskId || null,
        capability: request.capability, action: request.action,
        approvalRequestId: request.approvalRequestId || null
      });
      if (!attestation || attestation.verified !== true ||
          typeof attestation.evidenceRef !== 'string' || !attestation.evidenceRef.trim()) {
        return { allow: false, reason: 'trusted_human_approval_missing_or_invalid' };
      }
    }
    const authorization = await this.store.authorize({
      grantId: request.grantId, agentId: request.agentId, taskId: request.taskId || null,
      capability: request.capability, now: Date.now()
    });
    if (!authorization.ok) return { allow: false, reason: authorization.reason };
    return { allow: true, reason: 'capability_and_trusted_approval_verified',
      authorization, approvalEvidenceRef: attestation && attestation.evidenceRef || null };
  }
}

function createAdaptiveControlPlane({ stateDir, ledger, capabilityStore, approvalVerifier, profiles, sandbox }) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw Error('stateDir is required');
  if (!ledger || typeof ledger.create !== 'function') throw Error('existing MicroFederation TaskLedger is required');
  const root = path.resolve(stateDir);
  const budgets = new BudgetLedger(path.join(root, 'budgets.json'));
  const candidates = new CandidateRepository(path.join(root, 'candidates'));
  const scheduler = new AdaptiveScheduler({ profiles: profiles || {
    research: { memoryMb: 128, cpuCores: 0.25 },
    code: { memoryMb: 512, cpuCores: 1 },
    inference: { memoryMb: 1024, cpuCores: 1, gpuMb: 1024 },
    remote: { memoryMb: 64, cpuCores: 0.1 }
  } });
  const gate = capabilityStore && approvalVerifier
    ? new CapabilityGate({ capabilityStore, approvalVerifier }) : null;
  return Object.freeze({
    budgets, candidates, scheduler, gate, sandbox: sandbox || null,
    async initialize() {
      await fs.mkdir(root, { recursive: true });
      await Promise.all([ledger.open && ledger.open(), budgets.open(), candidates.open(),
        capabilityStore && capabilityStore.open ? capabilityStore.open() : Promise.resolve()]);
      return this;
    },
    async telemetry(providerTelemetry) { return scheduler.refresh(providerTelemetry); },
    async enqueue({ id, payload, requiredCapabilities = [], maxAttempts = 3, metadata = {} }) {
      return ledger.create({ id, payload, requiredCapabilities, maxAttempts, metadata });
    },
    async authorizeAction(request) {
      if (!gate) throw Error('capability gate is not configured; refusing authorization');
      return gate.authorize(request);
    },
    async evaluateCandidate({ candidate, candidateDirectory, command, args = [] }) {
      const stored = await candidates.put(candidate);
      if (!sandbox) throw Error('sandbox evaluator is not configured; candidate stored as unverified');
      const result = await sandbox.evaluate({ candidateDirectory, command, args });
      await candidates.recordEvaluation(stored.id, {
        fitness: { executionSucceeded: result.ok, elapsedMs: result.elapsedMs },
        verification: { status: result.ok ? 'sandbox-passed' : 'sandbox-failed',
          sandbox: result.sandbox, exitCode: result.exitCode }
      });
      return { candidateId: stored.id, evaluation: result };
    },
    async runScheduled(kind, work, options) { return scheduler.run(kind, work, options); },
    startTelemetry({ intervalMs = 5000, getProviderTelemetry = async () => ({}), onError = () => {} } = {}) {
      if (!Number.isInteger(intervalMs) || intervalMs < 250) throw Error('intervalMs must be at least 250ms');
      if (typeof getProviderTelemetry !== 'function' || typeof onError !== 'function') throw Error('telemetry callbacks must be functions');
      let stopped = false;
      let timer = null;
      const cycle = async () => {
        if (stopped) return;
        try { await scheduler.refresh(await getProviderTelemetry()); }
        catch (error) { onError(error); }
        if (!stopped) { timer = setTimeout(cycle, intervalMs); if (timer.unref) timer.unref(); }
      };
      void cycle();
      return Object.freeze({ stop() { stopped = true; if (timer) clearTimeout(timer); }, get stopped() { return stopped; } });
    },
    async runEvolution({ taskId, generator, evaluator, signal, shouldContinue = async () => true } = {}) {
      if (!ID.test(taskId || '') || typeof generator !== 'function' || typeof evaluator !== 'function' ||
          typeof shouldContinue !== 'function') throw Error('taskId, generator, evaluator and shouldContinue are required');
      const budget = await budgets.get(taskId);
      if (!budget) throw Error('evolution task has no allocated budget');
      const history = [];
      let generation = 0;
      while (!signal || !signal.aborted) {
        if (!(await shouldContinue({ taskId, generation, history: clone(history), budget: await budgets.get(taskId) }))) break;
        let generated;
        try {
          generated = await generator({ taskId, generation, parents: history.slice(-8).map(x => x.candidateId), signal });
        } catch (error) {
          history.push({ generation, status: 'generator-failed', error: String(error && error.message || error) });
          break;
        }
        if (!generated || !generated.candidate || !generated.usage) throw Error('generator must return candidate and measured usage');
        const usage = generated.usage;
        for (const resource of ['tokens', 'currencyMicros', 'computeMs', 'networkBytes']) {
          const amount = Number(usage[resource] || 0);
          if (!Number.isFinite(amount) || amount < 0) throw Error('generator returned invalid usage for ' + resource);
          if (amount > 0) await budgets.consume(taskId, resource, amount);
        }
        if (!Object.values(usage).some(value => Number(value) > 0)) {
          throw Error('evolution generator must report non-zero measured usage to prevent unbudgeted infinite execution');
        }
        const candidate = { ...generated.candidate, generation,
          parentIds: Array.isArray(generated.candidate.parentIds) ? generated.candidate.parentIds : [],
          provenance: generated.candidate.provenance || { taskId, generation } };
        const stored = await candidates.put(candidate);
        const evaluation = await evaluator({ candidate: stored, generated, signal });
        await candidates.recordEvaluation(stored.id, evaluation);
        history.push({ generation, candidateId: stored.id, evaluation });
        generation++;
        const remaining = await budgets.get(taskId);
        if (Object.values(remaining.remaining).every(value => value <= 0)) break;
      }
      return { taskId, generations: history.length, history, stopped: !!(signal && signal.aborted),
        remainingBudget: await budgets.get(taskId) };
    },
    async status() {
      const telemetry = scheduler.snapshot;
      return { schema: SCHEMA, initialized: !!budgets.state && !!candidates.index,
        telemetry, scheduler: scheduler.stats() };
    }
  });
}

module.exports = {
  SCHEMA, HIGH_IMPACT, collectTelemetry, deriveCapacity, BudgetLedger,
  CandidateRepository, AdaptiveScheduler, DockerSandbox, CredentialBroker, CapabilityGate,
  createAdaptiveControlPlane, atomicJson, sha256
};
