import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_TASK_SCHEMA = 'heavenzfire.shared-task.v1';
export const DEFAULT_TASK_INBOX_HOST = '127.0.0.1';
export const DEFAULT_TASK_INBOX_PORT = 18796;
export const DEFAULT_MAX_BODY_BYTES = 65536;

const RECORD_KEYS = ['schema', 'taskId', 'source', 'goal', 'status', 'approvalState', 'evidence', 'createdAt', 'updatedAt', 'metadata'];
const EVIDENCE_KEYS = ['kind', 'summary', 'sourceUrl', 'observedAt', 'actor'];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(label + ' has missing or unsupported fields.');
  }
}
function boundedText(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(field + ' must be a non-empty string no longer than ' + max + ' characters.');
  }
  return value.trim();
}
function validTimestamp(value, field) {
  boundedText(value, field, 64);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(field + ' must be a canonical ISO-8601 UTC timestamp.');
  }
}
export function validateProposedTaskRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('taskRecord must be an object.');
  exactKeys(record, RECORD_KEYS, 'taskRecord');
  if (record.schema !== SHARED_TASK_SCHEMA) throw new TypeError('unsupported task schema.');
  boundedText(record.taskId, 'taskId', 128);
  boundedText(record.source, 'source', 128);
  boundedText(record.goal, 'goal', 12000);
  if (record.status !== 'proposed' || record.approvalState !== 'pending') {
    throw new TypeError('only proposed/pending task records may enter the inbox.');
  }
  validTimestamp(record.createdAt, 'createdAt');
  validTimestamp(record.updatedAt, 'updatedAt');
  if (!Array.isArray(record.evidence) || record.evidence.length > 100) {
    throw new TypeError('evidence must be an array with at most 100 entries.');
  }
  for (const [index, item] of record.evidence.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('evidence[' + index + '] must be an object.');
    const required = EVIDENCE_KEYS.filter(key => key !== 'sourceUrl');
    if (Object.keys(item).some(key => !EVIDENCE_KEYS.includes(key)) ||
        required.some(key => !Object.prototype.hasOwnProperty.call(item, key))) {
      throw new TypeError('evidence[' + index + '] has missing or unsupported fields.');
    }
    boundedText(item.kind, 'evidence.kind', 80);
    boundedText(item.summary, 'evidence.summary', 2000);
    if (item.sourceUrl !== null && item.sourceUrl !== undefined &&
        (typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 1000)) {
      throw new TypeError('evidence.sourceUrl must be null or a string up to 1000 characters.');
    }
    validTimestamp(item.observedAt, 'evidence.observedAt');
    boundedText(item.actor, 'evidence.actor', 128);
  }
  if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    throw new TypeError('metadata must be a JSON object.');
  }
  const metadataJson = JSON.stringify(record.metadata);
  if (typeof metadataJson !== 'string' || Buffer.byteLength(metadataJson, 'utf8') > 32768) {
    throw new RangeError('metadata exceeds the 32768-byte limit.');
  }
  return true;
}
function readAndVerifyJournal(filePath) {
  if (!existsSync(filePath)) return { entries: [], byTaskId: new Map(), sequence: 0, previousHash: '0'.repeat(64) };
  const content = readFileSync(filePath, 'utf8');
  if (!content) return { entries: [], byTaskId: new Map(), sequence: 0, previousHash: '0'.repeat(64) };
  if (!content.endsWith('\n')) throw new Error('task inbox journal has an incomplete final record.');
  const lines = content.slice(0, -1).split('\n');
  const entries = [];
  const byTaskId = new Map();
  let previousHash = '0'.repeat(64);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let entry;
    try { entry = JSON.parse(lines[index]); }
    catch { throw new Error('malformed task inbox JSON at line ' + lineNumber + '.'); }
    exactKeys(entry, ['sequence', 'previousHash', 'receivedAt', 'taskRecord', 'hash'], 'journal entry');
    if (entry.sequence !== lineNumber || entry.previousHash !== previousHash ||
        typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash)) {
      throw new Error('invalid task inbox sequence or chain metadata at line ' + lineNumber + '.');
    }
    validTimestamp(entry.receivedAt, 'receivedAt');
    validateProposedTaskRecord(entry.taskRecord);
    const expectedHash = sha256(canonicalJson({
      sequence: entry.sequence, previousHash: entry.previousHash,
      receivedAt: entry.receivedAt, taskRecord: entry.taskRecord,
    }));
    if (entry.hash !== expectedHash) throw new Error('task inbox hash mismatch at line ' + lineNumber + '.');
    if (byTaskId.has(entry.taskRecord.taskId)) throw new Error('duplicate taskId in inbox journal at line ' + lineNumber + '.');
    byTaskId.set(entry.taskRecord.taskId, { digest: sha256(canonicalJson(entry.taskRecord)), entry });
    entries.push(entry);
    previousHash = entry.hash;
  }
  return { entries, byTaskId, sequence: entries.length, previousHash };
}
function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function sendJson(response, status, body) {
  if (response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}
function readJsonBody(request, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    request.on('data', chunk => {
      if (exceeded) return;
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        reject(Object.assign(new Error('request body exceeds the configured limit.'), { statusCode: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('request body must be valid JSON.'), { statusCode: 400 })); }
    });
    request.on('error', reject);
  });
}
function appendDurably(filePath, entry) {
  const fd = openSync(filePath, 'a', 0o600);
  try {
    const buffer = Buffer.from(JSON.stringify(entry) + '\n', 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('task inbox journal append made no forward progress.');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Loopback-only durable proposal inbox. It validates and records proposed/pending
 * tasks; it deliberately has no approval, execution, or dispatch endpoint.
 * A process lock enforces one writer per journal file. A stale lock after a crash
 * must be inspected and removed manually only after confirming its PID is gone.
 */
export function createTaskInboxServer({ filePath, host = DEFAULT_TASK_INBOX_HOST, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath is required.');
  if (host !== DEFAULT_TASK_INBOX_HOST) throw new Error('task inbox may bind only to 127.0.0.1.');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1024 * 1024) {
    throw new RangeError('maxBodyBytes must be between 1024 and 1048576.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const lockPath = absolutePath + '.lock';
  const lockContent = JSON.stringify({ pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() }) + '\n';
  let lockFd;
  let lockAcquired = false;
  try {
    lockFd = openSync(lockPath, 'wx', 0o600);
    lockAcquired = true;
    writeSync(lockFd, lockContent, null, 'utf8');
    fsyncSync(lockFd);
  } catch (error) {
    if (lockFd !== undefined) closeSync(lockFd);
    if (lockAcquired) { try { unlinkSync(lockPath); } catch {} }
    throw new Error('task inbox journal is already locked; inspect the lock owner before recovery.', { cause: error });
  }
  closeSync(lockFd);
  let lockHeld = true;
  function releaseLock() {
    if (!lockHeld) return;
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === lockContent) unlinkSync(lockPath);
    } finally { lockHeld = false; }
  }
  let replay;
  try { replay = readAndVerifyJournal(absolutePath); }
  catch (error) { releaseLock(); throw error; }
  let sequence = replay.sequence;
  let previousHash = replay.previousHash;
  const byTaskId = replay.byTaskId;
  let storageFault = null;

  function health() {
    return { ok: storageFault === null, service: 'unified-field-task-inbox',
      entries: sequence, head: previousHash, executionEnabled: false };
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (!isLoopback(request.socket.remoteAddress)) {
        sendJson(response, 403, { ok: false, error: 'loopback_only' });
        return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, storageFault ? 503 : 200, health());
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/tasks')) {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname !== '/api/tasks' || storageFault) {
          sendJson(response, storageFault ? 503 : 404, { ok: false, error: storageFault ? 'storage_fault' : 'not_found' });
          return;
        }
        const rawLimit = url.searchParams.get('limit') ?? '50';
        const rawOffset = url.searchParams.get('offset') ?? '0';
        if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) {
          sendJson(response, 400, { ok: false, error: 'limit_and_offset_must_be_non_negative_integers' });
          return;
        }
        const limit = Number(rawLimit);
        const offset = Number(rawOffset);
        if (limit < 1 || limit > 100 || offset > 100000) {
          sendJson(response, 400, { ok: false, error: 'limit_must_be_1_to_100_and_offset_at_most_100000' });
          return;
        }
        const ordered = [...byTaskId.values()].sort((a, b) => b.entry.sequence - a.entry.sequence);
        const tasks = ordered.slice(offset, offset + limit).map(({ entry }) => ({
          taskId: entry.taskRecord.taskId, source: entry.taskRecord.source, goal: entry.taskRecord.goal,
          status: entry.taskRecord.status, approvalState: entry.taskRecord.approvalState,
          createdAt: entry.taskRecord.createdAt, updatedAt: entry.taskRecord.updatedAt,
        }));
        sendJson(response, 200, { ok: true, tasks, total: ordered.length, limit, offset, executionEnabled: false });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/api/tasks') {
        sendJson(response, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (storageFault) {
        sendJson(response, 503, { ok: false, error: 'storage_fault' });
        return;
      }
      const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        sendJson(response, 415, { ok: false, error: 'content_type_must_be_application_json' });
        return;
      }
      let payload;
      try { payload = await readJsonBody(request, maxBodyBytes); }
      catch (error) {
        sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, 'taskRecord')) {
        sendJson(response, 400, { ok: false, error: 'body_must_contain_only_taskRecord' });
        return;
      }
      try { validateProposedTaskRecord(payload.taskRecord); }
      catch (error) {
        sendJson(response, 422, { ok: false, error: error.message });
        return;
      }
      const taskId = payload.taskRecord.taskId;
      const recordDigest = sha256(canonicalJson(payload.taskRecord));
      const existing = byTaskId.get(taskId);
      if (existing) {
        if (existing.digest !== recordDigest) {
          sendJson(response, 409, { ok: false, error: 'task_id_conflict', taskId });
          return;
        }
        sendJson(response, 200, { ok: true, duplicate: true, taskId, status: 'proposed', approvalState: 'pending' });
        return;
      }
      const receivedAt = now();
      try { validTimestamp(receivedAt, 'receivedAt'); }
      catch {
        sendJson(response, 500, { ok: false, error: 'clock_invalid' });
        return;
      }
      const body = { sequence: sequence + 1, previousHash, receivedAt, taskRecord: payload.taskRecord };
      const entry = { ...body, hash: sha256(canonicalJson(body)) };
      try { appendDurably(absolutePath, entry); }
      catch {
        storageFault = new Error('durable append failed');
        sendJson(response, 503, { ok: false, error: 'storage_fault' });
        return;
      }
      sequence = entry.sequence;
      previousHash = entry.hash;
      byTaskId.set(taskId, { digest: recordDigest, entry });
      sendJson(response, 201, { ok: true, duplicate: false, taskId, status: 'proposed', approvalState: 'pending' });
    })().catch(() => sendJson(response, 500, { ok: false, error: 'internal_error' }));
  });

  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 50;
  return Object.freeze({
    server, storagePath: absolutePath, health,
    listen(port = DEFAULT_TASK_INBOX_PORT) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be between 0 and 65535.');
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, DEFAULT_TASK_INBOX_HOST, () => {
          server.removeListener('error', reject);
          resolveListen(server.address());
        });
      });
    },
    close() {
      return new Promise((resolveClose, reject) => {
        if (!server.listening) {
          try { releaseLock(); resolveClose(); } catch (error) { reject(error); }
          return;
        }
        server.close(error => {
          if (error) { reject(error); return; }
          try { releaseLock(); resolveClose(); } catch (releaseError) { reject(releaseError); }
        });
      });
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataRoot = process.env.LOCALAPPDATA || process.env.HOME || process.env.USERPROFILE || process.cwd();
  const filePath = process.env.HF_TASK_INBOX_FILE || resolve(dataRoot, 'HeavenzFire', 'task-inbox.jsonl');
  const port = Number(process.env.HF_TASK_INBOX_PORT || DEFAULT_TASK_INBOX_PORT);
  const inbox = createTaskInboxServer({ filePath });
  inbox.listen(port).then(address => {
    process.stdout.write('Unified Field task inbox listening on http://127.0.0.1:' + address.port + '/api/tasks\n');
  }).catch(async error => {
    await inbox.close().catch(() => {});
    process.stderr.write('Task inbox failed to start: ' + error.message + '\n');
    process.exitCode = 1;
  });
  const shutdown = () => inbox.close().then(() => process.exit(0)).catch(() => process.exit(1));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
