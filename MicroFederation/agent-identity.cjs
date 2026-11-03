'use strict';

const crypto = require('node:crypto');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9._-]{0,63}$/;
const TOKEN_TYPE = 'HFA1';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function encode(value) {
  return Buffer.from(canonical(value), 'utf8').toString('base64url');
}

function decode(segment, label) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw Error(label + '_encoding_invalid');
  }
  const decoded = Buffer.from(segment, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== segment) {
    throw Error(label + '_encoding_noncanonical');
  }
  let value;
  try { value = JSON.parse(decoded); } catch { throw Error(label + '_json_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      canonical(value) !== decoded) throw Error(label + '_json_noncanonical');
  return value;
}

function publicKeyFor(value) {
  const key = crypto.createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('trusted key must be Ed25519');
  return key;
}

function createAgentIdentity({
  issuer,
  keyId,
  privateKey,
  trustedIssuers,
  audience,
  isRevoked,
  clock = () => Date.now(),
  maxTtlSeconds = 300,
  clockSkewSeconds = 30
} = {}) {
  if (typeof issuer !== 'string' || !ID.test(issuer)) throw Error('issuer is invalid');
  if (typeof keyId !== 'string' || !ID.test(keyId)) throw Error('keyId is invalid');
  if (typeof audience !== 'string' || !ID.test(audience)) throw Error('audience is invalid');
  if (!Number.isInteger(maxTtlSeconds) || maxTtlSeconds < 1 || maxTtlSeconds > 900) {
    throw Error('maxTtlSeconds must be 1..900');
  }
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 120) {
    throw Error('clockSkewSeconds must be 0..120');
  }
  if (typeof isRevoked !== 'function') {
    throw Error('a revocation-store isRevoked(jti) function is required');
  }
  if (!trustedIssuers || typeof trustedIssuers !== 'object' || Array.isArray(trustedIssuers)) {
    throw Error('trustedIssuers must be an issuer-to-key map');
  }

  const signingKey = crypto.createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519') throw Error('signing key must be Ed25519');
  const trusted = new Map();
  for (const [trustedIssuer, keys] of Object.entries(trustedIssuers)) {
    if (!ID.test(trustedIssuer) || !keys || typeof keys !== 'object' || Array.isArray(keys)) {
      throw Error('trusted issuer key map is invalid');
    }
    const mapped = new Map();
    for (const [kid, key] of Object.entries(keys)) {
      if (!ID.test(kid)) throw Error('trusted key id is invalid');
      mapped.set(kid, publicKeyFor(key));
    }
    trusted.set(trustedIssuer, mapped);
  }
  if (!trusted.get(issuer) || !trusted.get(issuer).has(keyId)) {
    throw Error('the active signing key must also be present in trustedIssuers');
  }

  function issue({ agentId, grantId, taskId, capabilities, ttlSeconds = maxTtlSeconds } = {}) {
    if (typeof agentId !== 'string' || !ID.test(agentId)) throw Error('agentId is invalid');
    if (typeof grantId !== 'string' || !ID.test(grantId)) throw Error('grantId is invalid');
    if (typeof taskId !== 'string' || !ID.test(taskId)) throw Error('taskId is required and invalid');
    if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 64 ||
        capabilities.some(value => typeof value !== 'string' || !CAPABILITY.test(value))) {
      throw Error('capabilities must contain 1..64 valid capability slugs');
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxTtlSeconds) {
      throw Error('ttlSeconds exceeds the configured token lifetime');
    }

    const now = Math.floor(clock() / 1000);
    if (!Number.isSafeInteger(now) || now < 0) throw Error('clock returned an invalid timestamp');
    const header = { alg: 'EdDSA', typ: TOKEN_TYPE, kid: keyId };
    const claims = {
      iss: issuer,
      sub: agentId,
      aud: audience,
      iat: now,
      exp: now + ttlSeconds,
      jti: crypto.randomUUID(),
      grantId,
      taskId,
      capabilities: [...new Set(capabilities)].sort()
    };
    const signingInput = encode(header) + '.' + encode(claims);
    const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), signingKey)
      .toString('base64url');
    return signingInput + '.' + signature;
  }

  async function verify(token, {
    expectedSubject,
    expectedTaskId,
    requiredCapability
  } = {}) {
    try {
      if (typeof token !== 'string' || token.length > 8192) return { ok: false, reason: 'token_invalid' };
      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'token_format_invalid' };
      const [headerPart, claimsPart, signaturePart] = parts;
      const header = decode(headerPart, 'header');
      const claims = decode(claimsPart, 'claims');
      if (header.alg !== 'EdDSA' || header.typ !== TOKEN_TYPE ||
          typeof header.kid !== 'string' || !ID.test(header.kid)) {
        return { ok: false, reason: 'token_header_invalid' };
      }
      if (typeof signaturePart !== 'string' || !/^[A-Za-z0-9_-]+$/.test(signaturePart)) {
        return { ok: false, reason: 'token_signature_invalid' };
      }
      const issuerKeys = trusted.get(claims.iss);
      const publicKey = issuerKeys && issuerKeys.get(header.kid);
      if (!publicKey) return { ok: false, reason: 'untrusted_issuer_or_key' };

      const signingInput = headerPart + '.' + claimsPart;
      const signature = Buffer.from(signaturePart, 'base64url');
      if (signature.toString('base64url') !== signaturePart ||
          !crypto.verify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature)) {
        return { ok: false, reason: 'token_signature_invalid' };
      }

      const now = Math.floor(clock() / 1000);
      if (claims.aud !== audience) return { ok: false, reason: 'audience_mismatch' };
      if (typeof claims.sub !== 'string' || !ID.test(claims.sub) ||
          typeof claims.grantId !== 'string' || !ID.test(claims.grantId) ||
          typeof claims.taskId !== 'string' || !ID.test(claims.taskId) ||
          typeof claims.jti !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.jti) ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          !Array.isArray(claims.capabilities) || claims.capabilities.length < 1 ||
          claims.capabilities.length > 64 ||
          claims.capabilities.some(value => typeof value !== 'string' || !CAPABILITY.test(value))) {
        return { ok: false, reason: 'token_claims_invalid' };
      }
      if (claims.iat > now + clockSkewSeconds || claims.exp <= now ||
          claims.exp <= claims.iat || claims.exp - claims.iat > maxTtlSeconds) {
        return { ok: false, reason: 'token_expired_or_time_invalid' };
      }
      if (expectedSubject !== undefined && claims.sub !== expectedSubject) {
        return { ok: false, reason: 'subject_mismatch' };
      }
      if (expectedTaskId !== undefined && claims.taskId !== expectedTaskId) {
        return { ok: false, reason: 'task_scope_mismatch' };
      }
      if (requiredCapability !== undefined && !claims.capabilities.includes(requiredCapability)) {
        return { ok: false, reason: 'capability_not_in_token' };
      }

      let revoked;
      try { revoked = await isRevoked(claims.jti); }
      catch { return { ok: false, reason: 'revocation_check_unavailable' }; }
      if (revoked !== false) return { ok: false, reason: 'token_revoked_or_revocation_unavailable' };
      return { ok: true, claims: Object.freeze({ ...claims, capabilities: [...claims.capabilities] }) };
    } catch {
      return { ok: false, reason: 'token_verification_failed' };
    }
  }

  return Object.freeze({ issue, verify, issuer, audience, keyId });
}

function createFabricIdentityPolicies({
  identity,
  capabilityGate,
  getWorkerToken,
  producerCapability = 'fabric.submit'
} = {}) {
  if (!identity || typeof identity.verify !== 'function') throw Error('agent identity verifier is required');
  if (!capabilityGate || typeof capabilityGate.authorize !== 'function') throw Error('CapabilityGate is required');
  if (typeof getWorkerToken !== 'function') throw Error('getWorkerToken is required');

  async function authorizeGrant({ token, subject, taskId, capability, action }) {
    const verified = await identity.verify(token, {
      expectedSubject: subject,
      expectedTaskId: taskId,
      requiredCapability: capability
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };
    const claims = verified.claims;
    const decision = await capabilityGate.authorize({
      agentId: claims.sub,
      grantId: claims.grantId,
      taskId: claims.taskId,
      capability,
      action: action || capability
    });
    if (!decision || decision.allow !== true) {
      return { ok: false, reason: decision && decision.reason || 'capability_gate_denied' };
    }
    return { ok: true, issuer: claims.iss, subject: claims.sub, grantId: claims.grantId };
  }

  return Object.freeze({
    async authenticateProducer({ principal, producerProof, taskId } = {}) {
      if (typeof principal !== 'string' || typeof taskId !== 'string') return { ok: false, reason: 'producer_identity_missing' };
      return authorizeGrant({
        token: producerProof, subject: principal, taskId,
        capability: producerCapability, action: producerCapability
      });
    },
    async authorizeWorker({ taskId, capability, peerId, action } = {}) {
      if (typeof taskId !== 'string' || typeof capability !== 'string' || typeof peerId !== 'string') {
        return { ok: false, reason: 'worker_identity_missing' };
      }
      let token;
      try { token = await getWorkerToken({ peerId, taskId, capability }); }
      catch { return { ok: false, reason: 'worker_token_unavailable' }; }
      return authorizeGrant({ token, subject: peerId, taskId, capability, action });
    }
  });
}

module.exports = { createAgentIdentity, createFabricIdentityPolicies, canonicalIdentityJson: canonical };
