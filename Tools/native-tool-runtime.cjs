'use strict';

/*
 * HeavenzFire Native Tool Runtime
 * Node.js 18+. Code-defined tools only; no dynamic code loading or shell execution.
 * Importing this module has no side effects.
 */
const crypto = require('node:crypto');

const TOOL_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const CAPABILITY = /^[a-z][a-z0-9._-]{0,63}$/;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'
]);

function jsonClone(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw Error(label + ' must be JSON serializable'); }
  if (encoded === undefined) throw Error(label + ' must be JSON serializable');
  return JSON.parse(encoded);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateSchema(schema, depth = 0, budget = { nodes: 0 }) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw Error('inputSchema nodes must be objects');
  }
  if (++budget.nodes > 256 || depth > 12) throw Error('inputSchema exceeds structural limits');
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) throw Error('unsupported inputSchema keyword: ' + key);
  }
  if (!SCHEMA_TYPES.has(schema.type)) throw Error('inputSchema type is unsupported');
  if (schema.enum !== undefined &&
      (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 64)) {
    throw Error('inputSchema enum must contain 1..64 values');
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      throw Error('inputSchema ' + key + ' must be a non-negative integer');
    }
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) {
      throw Error('inputSchema ' + key + ' must be finite');
    }
  }
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw Error('object inputSchema requires properties');
    }
    if (schema.additionalProperties !== false) {
      throw Error('object inputSchema must set additionalProperties: false');
    }
    const keys = Object.keys(schema.properties);
    if (keys.length > 64) throw Error('object inputSchema has too many properties');
    if (schema.required !== undefined &&
        (!Array.isArray(schema.required) || schema.required.some(x => typeof x !== 'string' || !keys.includes(x)))) {
      throw Error('inputSchema required must reference declared properties');
    }
    for (const child of Object.values(schema.properties)) validateSchema(child, depth + 1, budget);
  } else if (schema.type === 'array') {
    if (!schema.items) throw Error('array inputSchema requires items');
    validateSchema(schema.items, depth + 1, budget);
  } else if (schema.properties !== undefined || schema.required !== undefined ||
             schema.additionalProperties !== undefined || schema.items !== undefined) {
    throw Error('object/array schema keywords used with an incompatible type');
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
    throw Error('inputSchema minLength exceeds maxLength');
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    throw Error('inputSchema minimum exceeds maximum');
  }
  return schema;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(value, schema, at = '$', errors = []) {
  if (!matchesType(value, schema.type)) {
    errors.push(at + ' must be ' + schema.type);
    return errors;
  }
  if (schema.enum && !schema.enum.some(item => canonical(item) === canonical(value))) {
    errors.push(at + ' is not an allowed value');
    return errors;
  }
  if (schema.type === 'object') {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(at + '.' + key + ' is required');
    }
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        errors.push(at + '.' + key + ' is not allowed');
      } else {
        validateValue(value[key], schema.properties[key], at + '.' + key, errors);
      }
    }
  } else if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(at + ' has too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(at + ' has too many items');
    value.forEach((item, index) => validateValue(item, schema.items, at + '[' + index + ']', errors));
  } else if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(at + ' is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(at + ' is too long');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(at + ' is below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(at + ' is above maximum');
  }
  return errors;
}

function validateToolDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('tool definition must be an object');
  const allowed = new Set(['id', 'version', 'description', 'capability', 'inputSchema', 'handler', 'timeoutMs']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw Error('unsupported tool field: ' + key);
  if (typeof input.id !== 'string' || !TOOL_ID.test(input.id)) throw Error('tool id is invalid');
  if (typeof input.version !== 'string' || !VERSION.test(input.version)) throw Error('tool version must be semantic x.y.z');
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 512) {
    throw Error('tool description must contain 1..512 characters');
  }
  if (typeof input.capability !== 'string' || !CAPABILITY.test(input.capability)) {
    throw Error('tool capability is invalid');
  }
  if (typeof input.handler !== 'function') throw Error('tool handler must be a code-defined function');
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw Error('tool timeoutMs must be between 1 and 300000');
  }
  validateSchema(input.inputSchema);
  return {
    id: input.id,
    version: input.version,
    description: input.description.trim(),
    capability: input.capability,
    inputSchema: deepFreeze(jsonClone(input.inputSchema, 'inputSchema')),
    handler: input.handler,
    timeoutMs
  };
}

class ToolRegistry {
  constructor() { this.tools = new Map(); }

  register(definition) {
    const tool = validateToolDefinition(definition);
    if (this.tools.has(tool.id)) throw Error('tool already registered: ' + tool.id);
    this.tools.set(tool.id, Object.freeze(tool));
    return this.describe(tool.id);
  }

  get(id) { return this.tools.get(id) || null; }

  describe(id) {
    const tool = this.get(id);
    if (!tool) return null;
    return {
      id: tool.id,
      version: tool.version,
      description: tool.description,
      capability: tool.capability,
      inputSchema: jsonClone(tool.inputSchema, 'inputSchema'),
      timeoutMs: tool.timeoutMs
    };
  }

  list() {
    return [...this.tools.keys()].sort().map(id => this.describe(id));
  }
}

class ToolRuntime {
  constructor({ registry, authorize, recordEvidence, maxInputBytes = 65536, maxOutputBytes = 262144 } = {}) {
    if (!registry || typeof registry.get !== 'function') throw Error('ToolRegistry is required');
    if (typeof authorize !== 'function') throw Error('authorization function is required');
    if (typeof recordEvidence !== 'function') throw Error('evidence recorder is required');
    if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 ||
        !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw Error('byte limits must be positive integers');
    this.registry = registry;
    this.authorize = authorize;
    this.recordEvidence = recordEvidence;
    this.maxInputBytes = maxInputBytes;
    this.maxOutputBytes = maxOutputBytes;
  }

  async _evidence(event) {
    await this.recordEvidence(Object.freeze({ schema: 'heavenzfire.tool-execution.v1', ...event }));
  }

  async execute({ toolId, input, principal, approvalRequestId = null, signal = null } = {}) {
    const startedAt = new Date().toISOString();
    const executionId = crypto.randomUUID();
    const tool = this.registry.get(toolId);
    if (!tool) throw Error('unknown tool: ' + String(toolId));
    if (!principal || typeof principal.agentId !== 'string' || !TOOL_ID.test(principal.agentId) ||
        typeof principal.grantId !== 'string' || !TOOL_ID.test(principal.grantId)) {
      throw Error('principal agentId and grantId are required');
    }
    if (principal.taskId !== undefined && principal.taskId !== null &&
        (typeof principal.taskId !== 'string' || !TOOL_ID.test(principal.taskId))) {
      throw Error('principal taskId is invalid');
    }
    if (signal !== null && (!signal || typeof signal.addEventListener !== 'function')) {
      throw Error('signal must be an AbortSignal');
    }

    const encodedInput = JSON.stringify(input);
    if (encodedInput === undefined || Buffer.byteLength(encodedInput, 'utf8') > this.maxInputBytes) {
      throw Error('tool input is not JSON serializable or exceeds maxInputBytes');
    }
    const errors = validateValue(input, tool.inputSchema);
    if (errors.length) throw Error('tool input validation failed: ' + errors.slice(0, 8).join('; '));
    const inputHash = sha256(canonical(input));

    const authorization = await this.authorize({
      grantId: principal.grantId,
      agentId: principal.agentId,
      taskId: principal.taskId || null,
      capability: tool.capability,
      action: 'tool.execute:' + tool.id,
      approvalRequestId
    });
    if (!authorization || authorization.allow !== true) {
      const reason = authorization && authorization.reason || 'authorization_denied';
      await this._evidence({
        executionId, toolId: tool.id, toolVersion: tool.version,
        agentId: principal.agentId, taskId: principal.taskId || null,
        capability: tool.capability, status: 'denied', inputHash,
        startedAt, completedAt: new Date().toISOString(), reason
      });
      throw Error('tool execution denied: ' + reason);
    }

    await this._evidence({
      executionId, toolId: tool.id, toolVersion: tool.version,
      agentId: principal.agentId, taskId: principal.taskId || null,
      capability: tool.capability, status: 'started', inputHash,
      approvalEvidenceRef: authorization.approvalEvidenceRef || null,
      startedAt
    });

    const controller = new AbortController();
    let timer;
    let externalAbort;
    let rejectAbort;
    const abortPromise = new Promise((resolve, reject) => {
      rejectAbort = reject;
      const abort = reason => {
        if (!controller.signal.aborted) controller.abort(reason);
        reject(Error(reason || 'tool execution aborted'));
      };
      externalAbort = () => abort('tool execution aborted by caller');
      if (signal) {
        if (signal.aborted) externalAbort();
        else signal.addEventListener('abort', externalAbort, { once: true });
      }
      timer = setTimeout(() => abort('tool execution timed out'), tool.timeoutMs);
      if (timer.unref) timer.unref();
    });

    try {
      const output = await Promise.race([
        Promise.resolve().then(() => tool.handler(jsonClone(input, 'tool input'), Object.freeze({
          executionId,
          principal: Object.freeze({ agentId: principal.agentId, taskId: principal.taskId || null }),
          signal: controller.signal
        }))),
        abortPromise
      ]);
      const encodedOutput = JSON.stringify(output);
      if (encodedOutput === undefined || Buffer.byteLength(encodedOutput, 'utf8') > this.maxOutputBytes) {
        throw Error('tool output is not JSON serializable or exceeds maxOutputBytes');
      }
      const outputHash = sha256(canonical(output));
      const completedAt = new Date().toISOString();
      await this._evidence({
        executionId, toolId: tool.id, toolVersion: tool.version,
        agentId: principal.agentId, taskId: principal.taskId || null,
        capability: tool.capability, status: 'succeeded', inputHash, outputHash,
        approvalEvidenceRef: authorization.approvalEvidenceRef || null,
        startedAt, completedAt
      });
      return { executionId, status: 'succeeded', tool: { id: tool.id, version: tool.version }, output, evidence: { inputHash, outputHash } };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = String(error && error.message || error).slice(0, 512);
      await this._evidence({
        executionId, toolId: tool.id, toolVersion: tool.version,
        agentId: principal.agentId, taskId: principal.taskId || null,
        capability: tool.capability, status: 'failed', inputHash,
        approvalEvidenceRef: authorization.approvalEvidenceRef || null,
        startedAt, completedAt, error: message
      });
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal && externalAbort) signal.removeEventListener('abort', externalAbort);
      if (rejectAbort) rejectAbort(Error('tool execution settled'));
    }
  }
}

module.exports = { ToolRegistry, ToolRuntime, validateToolDefinition, validateSchema, validateValue, sha256 };
