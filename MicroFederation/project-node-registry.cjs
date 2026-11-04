'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SCHEMA = 'heavenzfire.project-node-registry.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z][a-z0-9._-]{0,63}$/;
const PLATFORMS = new Set(['windows', 'android', 'linux', 'macos', 'unknown']);
const TRANSPORTS = new Set(['loopback', 'tailscale', 'lan', 'usb', 'unknown']);
const NODE_STATES = new Set(['online', 'offline', 'quarantined']);
const PROJECT_STATES = new Set(['registered', 'active', 'paused', 'archived']);
const LOCK_TIMEOUT_MS = 10000;
const LOCK_POLL_MS = 35;
const LOCK_STALE_MS = 30000;
const clone = value => JSON.parse(JSON.stringify(value));

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function hash(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
function requireId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw Error(label + ' is invalid');
  return value;
}
function requireText(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw Error(label + ' must contain 1..' + max + ' characters');
  }
  return value.trim();
}
function normalizeWorkspacePath(value) {
  const raw = requireText(value, 'workspacePath', 1024);
  if (path.posix.isAbsolute(raw)) return path.posix.normalize(raw);
  if (path.win32.isAbsolute(raw)) return path.win32.normalize(raw);
  throw Error('workspacePath must be an absolute Windows or POSIX path');
}
function validateRemote(value) {
  if (value === undefined || value === null || value === '') return null;
  const remote = requireText(value, 'remoteUrl', 512);
  if (/^https:\/\//i.test(remote)) {
    let parsed;
    try { parsed = new URL(remote); } catch { throw Error('remoteUrl is invalid'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw Error('remoteUrl must be credential-free HTTPS without query or fragment');
    }
    return remote;
  }
  if (/^git@[^:]+:.+$/i.test(remote) && !/\s/.test(remote)) return remote;
  throw Error('remoteUrl must be credential-free HTTPS or SSH');
}
function validateProject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('project must be an object');
  const allowed = new Set(['id', 'name', 'workspacePath', 'remoteUrl', 'branch', 'status']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw Error('unsupported project field: ' + key);
  const id = requireId(input.id, 'project id');
  const name = requireText(input.name, 'project name', 160);
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const remoteUrl = validateRemote(input.remoteUrl);
  const branch = input.branch === undefined || input.branch === null ? null : requireText(input.branch, 'branch', 255);
  const status = input.status === undefined ? 'registered' : input.status;
  if (!PROJECT_STATES.has(status)) throw Error('project status is invalid');
  return { id, name, workspacePath, remoteUrl, branch, status };
}
function validateMetrics(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('metrics must be an object');
  const allowed = new Set(['cpuLoadPercent', 'memoryTotalBytes', 'memoryAvailableBytes', 'storageFreeBytes']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw Error('unsupported metric: ' + key);
  const result = {};
  for (const key of allowed) {
    if (input[key] === undefined || input[key] === null) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error(key + ' must be a non-negative finite number');
    if (key === 'cpuLoadPercent' && value > 100) throw Error('cpuLoadPercent must be between 0 and 100');
    if (key !== 'cpuLoadPercent' && !Number.isSafeInteger(value)) throw Error(key + ' must be a safe integer');
    result[key] = value;
  }
  if (result.memoryTotalBytes !== undefined && result.memoryAvailableBytes !== undefined &&
      result.memoryAvailableBytes > result.memoryTotalBytes) throw Error('available memory exceeds total memory');
  return result;
}
function validateNode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('node must be an object');
  const allowed = new Set(['id', 'label', 'platform', 'transport', 'status', 'capabilities', 'lastSeenAt', 'metrics']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw Error('unsupported node field: ' + key);
  const id = requireId(input.id, 'node id');
  const label = requireText(input.label, 'node label', 160);
  if (!PLATFORMS.has(input.platform)) throw Error('node platform is invalid');
  if (!TRANSPORTS.has(input.transport)) throw Error('node transport is invalid');
  const status = input.status === undefined ? 'offline' : input.status;
  if (!NODE_STATES.has(status)) throw Error('node status is invalid');
  const capabilities = input.capabilities === undefined ? [] : input.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > 64 ||
      capabilities.some(x => typeof x !== 'string' || !SLUG.test(x))) throw Error('node capabilities are invalid');
  const uniqueCapabilities = [...new Set(capabilities)].sort();
  const lastSeenAt = input.lastSeenAt === undefined || input.lastSeenAt === null ? null : input.lastSeenAt;
  if (lastSeenAt !== null && (typeof lastSeenAt !== 'string' || !Number.isFinite(Date.parse(lastSeenAt)))) {
    throw Error('lastSeenAt must be an ISO-compatible timestamp');
  }
  return { id, label, platform: input.platform, transport: input.transport, status,
    capabilities: uniqueCapabilities, lastSeenAt, metrics: validateMetrics(input.metrics) };
}
function emptyManifest() {
  return { schema: SCHEMA, revision: 0, updatedAt: null, projects: [], nodes: [], events: [] };
}
function eventHash(event) {
  return hash({ sequence: event.sequence, type: event.type, actor: event.actor,
    at: event.at, payload: event.payload, previousHash: event.previousHash });
}
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schema !== SCHEMA ||
      !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
      !Array.isArray(manifest.projects) || !Array.isArray(manifest.nodes) || !Array.isArray(manifest.events) ||
      manifest.revision !== manifest.events.length) throw Error('registry manifest schema or revision is invalid');
  const projectIds = new Set();
  for (const project of manifest.projects) {
    const projectFields = new Set(['id', 'name', 'workspacePath', 'remoteUrl', 'branch', 'status', 'createdAt', 'updatedAt']);
    for (const key of Object.keys(project)) if (!projectFields.has(key)) throw Error('unsupported project record field: ' + key);
    const validated = validateProject({ id: project.id, name: project.name, workspacePath: project.workspacePath,
      remoteUrl: project.remoteUrl, branch: project.branch, status: project.status });
    if (projectIds.has(validated.id)) throw Error('registry contains duplicate project id');
    projectIds.add(validated.id);
    if (typeof project.createdAt !== 'string' || !Number.isFinite(Date.parse(project.createdAt)) ||
        typeof project.updatedAt !== 'string' || !Number.isFinite(Date.parse(project.updatedAt))) {
      throw Error('registry project timestamps are invalid');
    }
  }
  const nodeIds = new Set();
  for (const node of manifest.nodes) {
    const validated = validateNode(node);
    if (nodeIds.has(validated.id)) throw Error('registry contains duplicate node id');
    nodeIds.add(validated.id);
  }
  let previousHash = '0'.repeat(64);
  for (let i = 0; i < manifest.events.length; i++) {
    const event = manifest.events[i];
    if (!event || event.sequence !== i + 1 || event.previousHash !== previousHash ||
        typeof event.type !== 'string' || typeof event.actor !== 'string' ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
        !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload) ||
        typeof event.hash !== 'string' || event.hash !== eventHash(event)) {
      throw Error('registry audit chain is invalid at sequence ' + (i + 1));
    }
    previousHash = event.hash;
  }
  if (manifest.updatedAt !== null && (typeof manifest.updatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.updatedAt)))) {
    throw Error('registry updatedAt is invalid');
  }
  return manifest;
}
function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class ProjectNodeRegistry {
  constructor(stateDirectory, options = {}) {
    if (typeof stateDirectory !== 'string' || !stateDirectory.trim()) throw Error('state directory is required');
    this.directory = path.resolve(stateDirectory);
    this.file = path.join(this.directory, 'registry.json');
    this.lockFile = path.join(this.directory, 'registry.lock');
    this.lockTimeoutMs = options.lockTimeoutMs === undefined ? LOCK_TIMEOUT_MS : options.lockTimeoutMs;
    this.lockStaleMs = options.lockStaleMs === undefined ? LOCK_STALE_MS : options.lockStaleMs;
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 100 || this.lockTimeoutMs > 120000) {
      throw Error('lockTimeoutMs must be between 100 and 120000');
    }
    if (!Number.isInteger(this.lockStaleMs) || this.lockStaleMs < 1000 || this.lockStaleMs > 3600000) {
      throw Error('lockStaleMs must be between 1000 and 3600000');
    }
    this.opening = null;
  }

  async open() {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await this._withLock(async () => {
        try { await this._readDisk(); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await this._persist(emptyManifest());
        }
      });
      return this;
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  async read() {
    await this.open();
    return clone(await this._readDisk());
  }

  async registerProject(input, options = {}) {
    const project = validateProject(input);
    return this._mutate('project.registered', { projectId: project.id, workspacePath: project.workspacePath }, options, manifest => {
      if (manifest.projects.some(item => item.id === project.id)) throw Error('project already exists: ' + project.id);
      const at = new Date(options.now === undefined ? Date.now() : options.now).toISOString();
      const record = { ...project, createdAt: at, updatedAt: at };
      manifest.projects.push(record);
      return record;
    });
  }

  async updateProject(projectId, patch, options = {}) {
    requireId(projectId, 'project id');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('project patch must be an object');
    const allowed = new Set(['name', 'workspacePath', 'remoteUrl', 'branch', 'status']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw Error('unsupported project patch field: ' + key);
    return this._mutate('project.updated', { projectId, changedFields: Object.keys(patch).sort() }, options, manifest => {
      const index = manifest.projects.findIndex(item => item.id === projectId);
      if (index < 0) throw Error('unknown project: ' + projectId);
      const current = manifest.projects[index];
      const merged = validateProject({ id: projectId, name: current.name, workspacePath: current.workspacePath,
        remoteUrl: current.remoteUrl, branch: current.branch, status: current.status, ...patch });
      const updated = { ...merged, createdAt: current.createdAt,
        updatedAt: new Date(options.now === undefined ? Date.now() : options.now).toISOString() };
      manifest.projects[index] = updated;
      return updated;
    });
  }

  async archiveProject(projectId, options = {}) {
    return this.updateProject(projectId, { status: 'archived' }, options);
  }

  async upsertNode(input, options = {}) {
    const node = validateNode(input);
    return this._mutate('node.upserted', { nodeId: node.id, status: node.status }, options, manifest => {
      const index = manifest.nodes.findIndex(item => item.id === node.id);
      if (index < 0) manifest.nodes.push(node);
      else manifest.nodes[index] = node;
      return node;
    });
  }

  async recordHeartbeat(nodeId, heartbeat, options = {}) {
    requireId(nodeId, 'node id');
    if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) throw Error('heartbeat must be an object');
    const allowed = new Set(['capabilities', 'metrics', 'status']);
    for (const key of Object.keys(heartbeat)) if (!allowed.has(key)) throw Error('unsupported heartbeat field: ' + key);
    return this._mutate('node.heartbeat', { nodeId, capabilities: heartbeat.capabilities || [] }, options, manifest => {
      const index = manifest.nodes.findIndex(item => item.id === nodeId);
      if (index < 0) throw Error('unknown node: ' + nodeId);
      const current = manifest.nodes[index];
      const updated = validateNode({ ...current, ...heartbeat, lastSeenAt: new Date(options.now === undefined ? Date.now() : options.now).toISOString() });
      manifest.nodes[index] = updated;
      return updated;
    });
  }

  async _mutate(type, payload, options, change) {
    await this.open();
    return this._withLock(async () => {
      const manifest = await this._readDisk();
      const result = change(manifest);
      const now = options.now === undefined ? Date.now() : options.now;
      if (!Number.isFinite(now)) throw Error('registry timestamp must be finite');
      const at = new Date(now).toISOString();
      const actor = options.actor === undefined ? 'local-user' : requireId(options.actor, 'audit actor');
      const event = { sequence: manifest.events.length + 1, type, actor, at, payload,
        previousHash: manifest.events.length ? manifest.events[manifest.events.length - 1].hash : '0'.repeat(64) };
      event.hash = eventHash(event);
      manifest.events.push(event);
      manifest.revision = event.sequence;
      manifest.updatedAt = at;
      await this._persist(manifest);
      return clone(result);
    });
  }

  async _readDisk() {
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw error; throw Error('registry manifest is unreadable: ' + error.message, { cause: error }); }
    return clone(validateManifest(parsed));
  }

  async _persist(manifest) {
    validateManifest(manifest);
    const temporary = this.file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.file);
      try {
        const directoryHandle = await fs.open(this.directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch (error) {
        if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES', 'EBADF'].includes(error.code)) throw error;
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async _withLock(operation) {
    const started = Date.now();
    const token = crypto.randomUUID();
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(this.lockFile, 'wx', 0o600);
        const owner = { pid: process.pid, hostname: os.hostname(), token, acquiredAt: new Date().toISOString() };
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
      } catch (error) {
        if (handle) { await handle.close().catch(() => {}); handle = null; }
        if (error.code !== 'EEXIST') throw error;
        await this._tryReclaimDeadLocalLock();
        if (Date.now() - started >= this.lockTimeoutMs) throw Error('registry lock timeout; another writer may be active');
        await sleep(LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      try {
        const owner = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
        if (owner.token === token && owner.pid === process.pid) await fs.unlink(this.lockFile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async _tryReclaimDeadLocalLock() {
    let owner;
    try { owner = JSON.parse(await fs.readFile(this.lockFile, 'utf8')); }
    catch { return false; }
    if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
    if (pidIsAlive(owner.pid)) return false;
    const quarantine = this.lockFile + '.stale.' + crypto.randomUUID();
    try {
      await fs.rename(this.lockFile, quarantine);
      await fs.unlink(quarantine).catch(() => {});
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      if (['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) return false;
      throw error;
    }
  }
}

module.exports = { ProjectNodeRegistry, SCHEMA, validateProject, validateNode, validateManifest };
