'use strict';

const ID = /^[a-z][a-z0-9.-]{0,63}$/;
const RISK = new Set(['read_only', 'bounded_reversible', 'privileged', 'destructive', 'credential_sensitive', 'security_sensitive', 'external_network']);
const clone = value => JSON.parse(JSON.stringify(value));

function validateDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('capability definition must be an object');
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw Error('capability id is invalid');
  if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.version)) throw Error('capability version must be numeric semver');
  if (typeof input.description !== 'string' || !input.description.trim()) throw Error('capability description is required');
  const dependencies = input.dependencies === undefined ? [] : input.dependencies;
  if (!Array.isArray(dependencies) || dependencies.some(x => typeof x !== 'string' || !ID.test(x))) throw Error('capability dependencies are invalid');
  if (dependencies.includes(input.id) || new Set(dependencies).size !== dependencies.length) throw Error('capability dependencies contain a self-reference or duplicate');
  const riskClass = input.riskClass || 'read_only';
  if (!RISK.has(riskClass)) throw Error('capability risk class is invalid');
  const origin = input.origin || null;
  if (origin !== null) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw Error('capability origin must be an HTTPS origin'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw Error('capability origin must be a bare HTTPS origin');
  }
  return Object.freeze({
    id: input.id,
    version: input.version,
    description: input.description.trim().slice(0, 500),
    dependencies: Object.freeze([...dependencies]),
    riskClass,
    origin
  });
}

class CapabilityFabric {
  constructor({ definitions = [], adapters = {}, allowedOrigins = [] } = {}) {
    if (!Array.isArray(definitions)) throw Error('capability definitions must be an array');
    if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) throw Error('capability adapters must be an object');
    if (!Array.isArray(allowedOrigins) || allowedOrigins.some(x => typeof x !== 'string')) throw Error('allowedOrigins must be a string array');
    this.allowedOrigins = new Set(allowedOrigins.map(value => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value) throw Error('allowed origins must be bare HTTPS origins');
      return value;
    }));
    this.definitions = new Map();
    this.adapters = new Map(Object.entries(adapters));
    this.states = new Map();
    this.active = new Set();
    this.events = [];
    for (const definition of definitions) this.register(definition);
  }

  register(input) {
    const definition = validateDefinition(input);
    if (this.definitions.has(definition.id)) throw Error('capability already registered: ' + definition.id);
    if (definition.origin && !this.allowedOrigins.has(definition.origin)) throw Error('capability origin is not allowlisted');
    this.definitions.set(definition.id, definition);
    this.states.set(definition.id, 'registered');
    this._event('registered', definition.id);
    return clone(definition);
  }

  list() {
    return [...this.definitions.values()].map(definition => ({
      ...clone(definition),
      state: this.states.get(definition.id)
    }));
  }

  resolve(requested) {
    if (!Array.isArray(requested) || !requested.length || requested.some(x => typeof x !== 'string' || !ID.test(x))) {
      throw Error('requested capabilities must be a non-empty array of capability ids');
    }
    const order = [], visiting = new Set(), visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw Error('capability dependency cycle detected at ' + id);
      const definition = this.definitions.get(id);
      if (!definition) throw Error('capability not registered: ' + id);
      visiting.add(id);
      for (const dependency of definition.dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };
    for (const id of requested) visit(id);
    return order;
  }

  plan(requested) {
    const order = this.resolve(requested);
    return {
      requested: [...requested],
      order,
      capabilities: order.map(id => {
        const definition = this.definitions.get(id);
        return { ...clone(definition), state: this.states.get(id), adapterAvailable: this.adapters.has(id) };
      })
    };
  }

  _event(type, id, detail = {}) {
    this.events.push({ at: new Date().toISOString(), type, id, ...detail });
    if (this.events.length > 1000) this.events.shift();
  }

  async load(requested, context = {}) {
    const order = this.resolve(requested);
    const newlyLoaded = [];
    for (const id of order) {
      if (this.states.get(id) === 'ready') continue;
      if (this.active.has(id)) throw Error('capability activation already in progress: ' + id);
      const adapter = this.adapters.get(id);
      if (typeof adapter !== 'function') throw Error('capability adapter unavailable: ' + id);
      this.active.add(id);
      this.states.set(id, 'loading');
      this._event('loading', id);
      try {
        await adapter({ capability: clone(this.definitions.get(id)), context });
        this.states.set(id, 'ready');
        newlyLoaded.push(id);
        this._event('ready', id);
      } catch (error) {
        this.states.set(id, 'failed');
        this._event('failed', id, { error: String(error && error.message || error).slice(0, 300) });
        for (const rollbackId of newlyLoaded.reverse()) {
          const rollback = this.adapters.get(rollbackId);
          try {
            if (rollback && typeof rollback.dispose === 'function') await rollback.dispose({ capability: clone(this.definitions.get(rollbackId)), context });
            this.states.set(rollbackId, 'registered');
            this._event('rolled_back', rollbackId);
          } catch (rollbackError) {
            this.states.set(rollbackId, 'failed');
            this._event('rollback_failed', rollbackId, { error: String(rollbackError && rollbackError.message || rollbackError).slice(0, 300) });
          }
        }
        throw Error('capability activation failed: ' + id + ': ' + String(error && error.message || error));
      } finally {
        this.active.delete(id);
      }
    }
    return { activated: order, states: order.map(id => ({ id, state: this.states.get(id) })) };
  }
}

function createGapiCompatibilityOverride({ gapi, fabric, prefix = 'hf.' } = {}) {
  if (!gapi || typeof gapi !== 'object' || typeof gapi.load !== 'function') throw Error('a compatible gapi.load function is required');
  if (!(fabric instanceof CapabilityFabric)) throw Error('CapabilityFabric instance is required');
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9.-]*\.$/.test(prefix)) throw Error('override prefix is invalid');
  const original = gapi.load;
  let installed = false;

  function wrappedLoad(features, options) {
    if (typeof features !== 'string') return original.call(gapi, features, options);
    const requested = features.split(':').filter(Boolean);
    const local = requested.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    const remote = requested.filter(name => !name.startsWith(prefix));
    if (!local.length) return original.call(gapi, features, options);

    const opts = typeof options === 'function' ? { callback: options } : { ...(options || {}) };
    const remoteLoad = remote.length ? new Promise((resolve, reject) => {
      const remoteOptions = {
        ...opts,
        callback: resolve,
        onerror: error => reject(error instanceof Error ? error : Error('Google module load failed')),
        ontimeout: () => reject(Error('Google module load timed out'))
      };
      try { original.call(gapi, remote.join(':'), remoteOptions); }
      catch (error) { reject(error); }
    }) : Promise.resolve();

    const operation = Promise.all([fabric.load(local, { source: 'gapi-compatibility-override' }), remoteLoad])
      .then(() => {
        if (typeof opts.callback === 'function') opts.callback();
        return { local, remote };
      })
      .catch(error => {
        if (typeof opts.onerror === 'function') opts.onerror(error);
        throw error;
      });
    return operation;
  }

  return {
    load: wrappedLoad,
    install() {
      if (installed) throw Error('GAPI compatibility override is already installed');
      if (gapi.load !== original) throw Error('gapi.load changed since override creation');
      gapi.load = wrappedLoad;
      installed = true;
      return () => {
        if (!installed) return false;
        if (gapi.load !== wrappedLoad) throw Error('gapi.load was replaced by another integration; refusing to overwrite it');
        gapi.load = original;
        installed = false;
        return true;
      };
    },
    get installed() { return installed; }
  };
}

module.exports = { CapabilityFabric, validateDefinition, createGapiCompatibilityOverride };
