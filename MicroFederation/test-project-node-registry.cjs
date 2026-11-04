'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProjectNodeRegistry, SCHEMA } = require('./project-node-registry.cjs');

async function tempDirectory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-project-node-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const project = (id, workspacePath) => ({
  id, name: 'Unified Field ' + id, workspacePath, remoteUrl: 'https://github.com/HeavenzFire/UnifiedCodebase',
  branch: 'main', status: 'registered'
});
const node = id => ({
  id, label: 'Android Termux', platform: 'android', transport: 'tailscale',
  status: 'offline', capabilities: ['model.inference', 'task.execute'], metrics: {}
});

test('creates a versioned manifest outside the workspace and preserves repository files', async t => {
  const root = await tempDirectory(t);
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'app-data');
  await fs.mkdir(workspace);
  const source = path.join(workspace, 'README.md');
  await fs.writeFile(source, '# Source of truth\n', 'utf8');
  const before = await fs.readFile(source);
  const registry = await new ProjectNodeRegistry(state).open();
  await registry.registerProject(project('unified-field', workspace), { now: 1000 });
  const manifest = await registry.read();
  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.revision, 1);
  assert.equal(manifest.projects[0].workspacePath, path.normalize(workspace));
  assert.deepEqual(await fs.readFile(source), before);
  assert.equal(await fs.access(path.join(state, 'registry.json')).then(() => true), true);
});

test('updates projects, archives without deleting, and appends verifiable audit events', async t => {
  const root = await tempDirectory(t);
  const registry = await new ProjectNodeRegistry(path.join(root, 'state')).open();
  await registry.registerProject(project('project-a', path.join(root, 'workspace')), { actor: 'test-suite', now: 1000 });
  await registry.updateProject('project-a', { branch: 'feature/registry' }, { actor: 'test-suite', now: 2000 });
  await registry.archiveProject('project-a', { actor: 'test-suite', now: 3000 });
  const manifest = await registry.read();
  assert.equal(manifest.projects[0].status, 'archived');
  assert.equal(manifest.projects[0].branch, 'feature/registry');
  assert.deepEqual(manifest.events.map(event => event.type),
    ['project.registered', 'project.updated', 'project.updated']);
  assert.equal(manifest.events[2].previousHash, manifest.events[1].hash);
  assert.equal(manifest.revision, 3);
});

test('registers nodes and records validated heartbeats without accepting credential fields', async t => {
  const root = await tempDirectory(t);
  const registry = await new ProjectNodeRegistry(path.join(root, 'state')).open();
  await registry.upsertNode(node('termux-a67l'), { now: 1000 });
  const heartbeat = await registry.recordHeartbeat('termux-a67l', {
    status: 'online', capabilities: ['model.inference', 'task.execute'],
    metrics: { cpuLoadPercent: 42.5, memoryTotalBytes: 2800000000, memoryAvailableBytes: 900000000,
      storageFreeBytes: 3200000000 }
  }, { actor: 'local-node-agent', now: 2000 });
  assert.equal(heartbeat.status, 'online');
  assert.equal(heartbeat.lastSeenAt, new Date(2000).toISOString());
  assert.equal(heartbeat.metrics.cpuLoadPercent, 42.5);
  await assert.rejects(registry.upsertNode({ ...node('bad-node'), apiKey: 'must-not-persist' }), /unsupported node field/);
});

test('rejects relative paths, credential-bearing remotes, and unsafe project fields', async t => {
  const root = await tempDirectory(t);
  const registry = await new ProjectNodeRegistry(path.join(root, 'state')).open();
  await assert.rejects(registry.registerProject(project('relative', 'workspace')), /absolute/);
  await assert.rejects(registry.registerProject({ ...project('secret-remote', path.join(root, 'w')),
    remoteUrl: 'https://user:secret@example.com/repo.git' }), /credential-free/);
  await assert.rejects(registry.registerProject({ ...project('extra', path.join(root, 'w')), apiKey: 'secret' }),
    /unsupported project field/);
});

test('detects manifest and audit-chain tampering and fails closed', async t => {
  const root = await tempDirectory(t);
  const state = path.join(root, 'state');
  const registry = await new ProjectNodeRegistry(state).open();
  await registry.registerProject(project('project-a', path.join(root, 'workspace')), { now: 1000 });
  const manifestPath = path.join(state, 'registry.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.events[0].payload.projectId = 'rewritten';
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await assert.rejects(new ProjectNodeRegistry(state).read(), /audit chain is invalid/);
});

test('serializes concurrent writers in separate Node processes without lost updates', async t => {
  const root = await tempDirectory(t);
  const state = path.join(root, 'state');
  const modulePath = path.join(__dirname, 'project-node-registry.cjs');
  const script = [
    "const {ProjectNodeRegistry}=require(process.argv[1]);",
    "const [state,id]=process.argv.slice(2);",
    "(async()=>{const r=await new ProjectNodeRegistry(state,{lockTimeoutMs:20000}).open();",
    "await r.registerProject({id,name:id,workspacePath:process.cwd(),status:'registered'});})().catch(e=>{console.error(e);process.exitCode=1;});"
  ].join('');
  const launch = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, state, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error('child failed: ' + stderr)));
  });
  await Promise.all([launch('writer-one'), launch('writer-two')]);
  const manifest = await new ProjectNodeRegistry(state).read();
  assert.deepEqual(manifest.projects.map(item => item.id).sort(), ['writer-one', 'writer-two']);
  assert.equal(manifest.revision, 2);
});

test('reclaims a dead same-host process lock after a crashed writer', async t => {
  const root = await tempDirectory(t);
  const state = path.join(root, 'state');
  await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'registry.lock'), JSON.stringify({
    pid: 2147483647, hostname: os.hostname(), token: 'abandoned-lock', acquiredAt: new Date(0).toISOString()
  }), 'utf8');
  const registry = await new ProjectNodeRegistry(state).open();
  await registry.registerProject(project('after-crash', path.join(root, 'workspace')));
  assert.equal((await registry.read()).projects.length, 1);
});
