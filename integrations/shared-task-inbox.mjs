#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "heavenzfire.shared-task.v1";
const ZERO_HASH = "0".repeat(64);
const DEFAULT_PORT = 18796;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function requiredText(value, field, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(field + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}
function validateTaskRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("taskRecord must be an object.");
  if (record.schema !== SCHEMA) throw new TypeError("Unsupported shared task schema.");
  requiredText(record.taskId, "taskId", 128);
  requiredText(record.source, "source", 128);
  requiredText(record.goal, "goal", 12000);
  requiredText(record.createdAt, "createdAt", 100);
  requiredText(record.updatedAt, "updatedAt", 100);
  if (Number.isNaN(Date.parse(record.createdAt)) || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new TypeError("Task timestamps must be valid dates.");
  }
  if (record.status !== "proposed" || record.approvalState !== "pending") {
    throw new TypeError("Inbox accepts proposals only in proposed/pending state.");
  }
  if (!Array.isArray(record.evidence) || record.evidence.length !== 0) {
    throw new TypeError("Inbox proposals must have an empty evidence array until independently reviewed.");
  }
  if (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) {
    throw new TypeError("Task metadata must be a JSON object.");
  }
  requiredText(record.metadata.requestedBy, "metadata.requestedBy", 128);
  requiredText(record.metadata.localLifecycleStatus, "metadata.localLifecycleStatus", 32);
  return clone(record);
}
function readAndVerify(filePath) {
  if (!existsSync(filePath)) return { records: [], previousHash: ZERO_HASH };
  const content = readFileSync(filePath, "utf8");
  if (!content) return { records: [], previousHash: ZERO_HASH };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const records = [];
  const seen = new Map();
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw new Error("Malformed shared task inbox journal JSON at line " + lineNumber + "."); }
    if (!record || record.sequence !== lineNumber || record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) || !record.entry) {
      throw new Error("Invalid shared task inbox journal chain at line " + lineNumber + ".");
    }
    const taskRecord = validateTaskRecord(record.entry.taskRecord);
    if (record.entry.taskId !== taskRecord.taskId || typeof record.entry.receivedAt !== "string") {
      throw new Error("Invalid shared task inbox entry at line " + lineNumber + ".");
    }
    if (seen.has(taskRecord.taskId)) throw new Error("Duplicate task ID in shared task inbox journal at line " + lineNumber + ".");
    const expected = sha256(canonicalJson({ sequence: record.sequence, previousHash: record.previousHash, entry: record.entry }));
    if (record.hash !== expected) throw new Error("Shared task inbox hash mismatch at line " + lineNumber + ".");
    seen.set(taskRecord.taskId, taskRecord);
    records.push(record);
    previousHash = record.hash;
  }
  return { records, previousHash };
}


function readAndVerifyClaims(filePath, taskIds) {
  if (!existsSync(filePath)) return { records: [], previousHash: ZERO_HASH, claims: new Map() };
  const content = readFileSync(filePath, "utf8");
  if (!content) return { records: [], previousHash: ZERO_HASH, claims: new Map() };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const records = [];
  const claims = new Map();
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw new Error("Malformed shared task claims JSON at line " + lineNumber + "."); }
    if (!record || record.sequence !== lineNumber || record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) || !record.event) {
      throw new Error("Invalid shared task claims chain at line " + lineNumber + ".");
    }
    const event = record.event;
    requiredText(event.taskId, "claim.taskId", 128);
    requiredText(event.workerId, "claim.workerId", 128);
    requiredText(event.at, "claim.at", 100);
    if (!taskIds.has(event.taskId) || Number.isNaN(Date.parse(event.at))) {
      throw new Error("Claim references an unknown task or invalid timestamp at line " + lineNumber + ".");
    }
    const expected = sha256(canonicalJson({ sequence: record.sequence, previousHash: record.previousHash, event }));
    if (record.hash !== expected) throw new Error("Shared task claims hash mismatch at line " + lineNumber + ".");
    const current = claims.get(event.taskId);
    if (event.action === "claim") {
      requiredText(event.expiresAt, "claim.expiresAt", 100);
      if (Number.isNaN(Date.parse(event.expiresAt)) || Date.parse(event.expiresAt) <= Date.parse(event.at)) {
        throw new Error("Invalid claim expiry at line " + lineNumber + ".");
      }
      if (current && Date.parse(current.expiresAt) > Date.parse(event.at) && current.workerId !== event.workerId) {
        throw new Error("Conflicting active claim in journal at line " + lineNumber + ".");
      }
      claims.set(event.taskId, { taskId: event.taskId, workerId: event.workerId, claimedAt: event.at, expiresAt: event.expiresAt });
    } else if (event.action === "release") {
      if (!current || current.workerId !== event.workerId) {
        throw new Error("Invalid claim release in journal at line " + lineNumber + ".");
      }
      claims.delete(event.taskId);
    } else {
      throw new Error("Unknown shared task claim action at line " + lineNumber + ".");
    }
    records.push(record);
    previousHash = record.hash;
  }
  return { records, previousHash, claims };
}

export function createSharedTaskInbox({ filePath, claimsFilePath, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("filePath is required.");
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  const absolutePath = resolve(filePath);
  const claimsPath = resolve(claimsFilePath || absolutePath + ".claims.jsonl");
  if (absolutePath === claimsPath) throw new TypeError("Proposal and claim journals must use separate paths.");
  mkdirSync(dirname(absolutePath), { recursive: true });
  mkdirSync(dirname(claimsPath), { recursive: true });
  const replay = readAndVerify(absolutePath);
  let sequence = replay.records.length;
  let previousHash = replay.previousHash;
  let records = replay.records;
  let byId = new Map(records.map(record => [record.entry.taskId, record.entry.taskRecord]));
  const claimReplay = readAndVerifyClaims(claimsPath, new Set(byId.keys()));
  let claimSequence = claimReplay.records.length;
  let claimPreviousHash = claimReplay.previousHash;
  let claimRecords = claimReplay.records;
  let claimsByTask = claimReplay.claims;
  let fault = null;

  function assertHealthy() {
    if (fault) {
      const error = new Error("Shared task inbox journal is faulted; restart and recover the journal before continuing.");
      error.cause = fault;
      throw error;
    }
  }

  function currentTime() {
    const value = now();
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError("now must return a valid date string.");
    return value;
  }

  function appendClaimEvent(event) {
    const body = { sequence: claimSequence + 1, previousHash: claimPreviousHash, event };
    const record = { ...body, hash: sha256(canonicalJson(body)) };
    try {
      appendFileSync(claimsPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
    } catch (error) {
      fault = error;
      throw error;
    }
    claimSequence = record.sequence;
    claimPreviousHash = record.hash;
    claimRecords = [...claimRecords, record];
    return record;
  }

  return Object.freeze({
    accept(input) {
      assertHealthy();
      const taskRecord = validateTaskRecord(input);
      const existing = byId.get(taskRecord.taskId);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(taskRecord)) {
          return { ok: true, duplicate: true, taskId: taskRecord.taskId, status: "proposed", approvalState: "pending" };
        }
        const error = new Error("Task ID already exists with a different proposal payload.");
        error.code = "TASK_ID_CONFLICT";
        throw error;
      }
      const entry = { taskId: taskRecord.taskId, receivedAt: now(), taskRecord };
      const body = { sequence: sequence + 1, previousHash, entry };
      const record = { ...body, hash: sha256(canonicalJson(body)) };
      try {
        appendFileSync(absolutePath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
      } catch (error) {
        fault = error;
        throw error;
      }
      sequence = record.sequence;
      previousHash = record.hash;
      records = [...records, record];
      byId.set(taskRecord.taskId, taskRecord);
      return { ok: true, duplicate: false, taskId: taskRecord.taskId, status: "proposed", approvalState: "pending" };
    },
    list() {
      assertHealthy();
      return [...byId.values()].map(clone);
    },
    audit() {
      assertHealthy();
      return readAndVerify(absolutePath).records.map(record => clone(record));
    },
    storagePath: absolutePath,
  });
}

/** HTTP surface is deliberately limited to health and proposal inbox routes on loopback. */
export function createSharedTaskInboxServer({ inbox, host = "127.0.0.1", maxBodyBytes = 1024 * 1024 } = {}) {
  if (!inbox || typeof inbox.accept !== "function" || typeof inbox.list !== "function") {
    throw new TypeError("A shared task inbox is required.");
  }
  if (host !== "127.0.0.1") throw new TypeError("Shared task inbox may bind only to 127.0.0.1.");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 10 * 1024 * 1024) {
    throw new RangeError("maxBodyBytes must be between 1024 and 10485760.");
  }

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/api/health") {
      send(200, { ok: true, status: "ok", service: "shared-task-inbox", mode: "proposal-only" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks") {
      try { send(200, { ok: true, tasks: inbox.list() }); }
      catch (error) { send(503, { ok: false, error: error.message }); }
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/tasks") {
      send(404, { ok: false, error: "not_found" });
      return;
    }
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      send(415, { ok: false, error: "content_type_must_be_application_json" });
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) {
          chunks.push(Buffer.from(chunk));
        }
      }
      if (tooLarge) {
        send(413, { ok: false, error: "request_body_too_large" });
        return;
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(400, { ok: false, error: "invalid_json" }); return; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.taskRecord) {
        send(400, { ok: false, error: "taskRecord_required" });
        return;
      }
      send(201, inbox.accept(payload.taskRecord));
    } catch (error) {
      if (error.code === "TASK_ID_CONFLICT") {
        send(409, { ok: false, error: "task_id_conflict" });
      } else if (error instanceof TypeError) {
        send(400, { ok: false, error: error.message });
      } else {
        send(503, { ok: false, error: error.message });
      }
    }
  });
  const nativeListen = server.listen.bind(server);
  server.listen = (...args) => {
    if (typeof args[0] !== "number") throw new TypeError("Shared task inbox requires an explicit numeric port.");
    let requestedHost;
    let callback;
    if (typeof args[1] === "string") {
      requestedHost = args[1];
      callback = args[2];
    } else if (typeof args[1] === "function") {
      callback = args[1];
    } else if (args[1] !== undefined) {
      throw new TypeError("Only listen(port, callback) and listen(port, host, callback) are supported.");
    }
    if (requestedHost !== undefined && requestedHost !== "127.0.0.1") {
      throw new TypeError("Shared task inbox may bind only to 127.0.0.1.");
    }
    return callback ? nativeListen(args[0], "127.0.0.1", callback) : nativeListen(args[0], "127.0.0.1");
  };
  return server;
}

function parseArgs(argv) {
  const stateDirectory = resolve(process.env.HEAVENZFIRE_STATE_DIR || join(homedir(), ".heavenzfire", "unified-field"));
  const args = { port: DEFAULT_PORT, filePath: join(stateDirectory, "shared-task-inbox.jsonl"), help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") args.port = Number(argv[++index]);
    else if (argv[index] === "--file") args.filePath = resolve(argv[++index]);
    else if (argv[index] === "--help" || argv[index] === "-h") args.help = true;
    else throw new Error("Unknown argument: " + argv[index]);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new RangeError("port must be between 1 and 65535.");
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log("Usage: node integrations/shared-task-inbox.mjs [--port 18796] [--file PATH]");
      console.log("Binds only to 127.0.0.1. Accepts proposed/pending tasks; it never approves or executes them.");
    } else {
      const inbox = createSharedTaskInbox({ filePath: args.filePath });
      const server = createSharedTaskInboxServer({ inbox });
      server.listen(args.port, "127.0.0.1", () => {
        console.log(JSON.stringify({ ok: true, host: "127.0.0.1", port: args.port, pid: process.pid, storagePath: inbox.storagePath, mode: "proposal-only" }));
      });
      server.on("error", error => {
        console.error(JSON.stringify({ ok: false, error: error.message }));
        process.exitCode = 1;
      });
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
