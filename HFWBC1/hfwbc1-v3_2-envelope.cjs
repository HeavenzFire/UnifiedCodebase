'use strict';

const crypto = require('node:crypto');

const ENVELOPE_MAGIC = Buffer.from('HFWG', 'ascii');
const FORMAT_VERSION = 0x01;
const MODE_RAW = 0x00;
const MODE_HFWBC1 = 0x01;
const HEADER_BYTES = 22;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const DEFAULT_MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024;

function assertByteInput(value, name) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(name + ' must be a Buffer or Uint8Array');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(name + ' must not use SharedArrayBuffer backing');
  }
  return value.byteLength;
}

function bytes(value, name) {
  assertByteInput(value, name);
  return Buffer.from(value);
}

function validateMaxCiphertextBytes(value) {
  const max = value === undefined ? DEFAULT_MAX_CIPHERTEXT_BYTES : value;
  if (!Number.isSafeInteger(max) || max < 0 || max > 0xffffffff) {
    throw new RangeError('maxCiphertextBytes must be an integer from 0 through 2^32-1');
  }
  return max;
}

function validateKey(value) {
  const key = bytes(value, 'key');
  if (key.length !== KEY_BYTES) throw new RangeError('AES-256-GCM key must be exactly 32 bytes');
  return key;
}

function validateNonce(value) {
  const nonce = bytes(value, 'nonce');
  if (nonce.length !== NONCE_BYTES) throw new RangeError('AES-GCM nonce must be exactly 12 bytes');
  return nonce;
}

function validateContext(value) {
  if (value === undefined || value === null) {
    throw new TypeError('context must be supplied explicitly as Buffer or Uint8Array');
  }
  return bytes(value, 'context');
}

function validateClaimProvider(value, name) {
  if (!value || typeof value.claim !== 'function') {
    throw new TypeError(name + ' must provide an atomic claim(keyFingerprint, ...recordIds) function');
  }
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function requireNewClaim(provider, name, ...claimArgs) {
  const claimed = await provider.claim(...claimArgs);
  if (claimed !== true) throw new Error(name + ' rejected a duplicate or unavailable claim');
}

function modeToByte(mode) {
  if (mode === 'raw') return MODE_RAW;
  if (mode === 'hfwbc1') return MODE_HFWBC1;
  throw new TypeError('mode must be "raw" or "hfwbc1"');
}

function byteToMode(value) {
  if (value === MODE_RAW) return 'raw';
  if (value === MODE_HFWBC1) return 'hfwbc1';
  throw new Error('unsupported encrypted payload mode');
}

function makeHeader(mode, nonce, ciphertextLength) {
  const header = Buffer.alloc(HEADER_BYTES);
  ENVELOPE_MAGIC.copy(header, 0);
  header[4] = FORMAT_VERSION;
  header[5] = modeToByte(mode);
  nonce.copy(header, 6);
  header.writeUInt32BE(ciphertextLength, 18);
  return header;
}

function parseEnvelope(input, options) {
  const opts = options || {};
  const maxCiphertextBytes = validateMaxCiphertextBytes(opts.maxCiphertextBytes);
  const inputLength = assertByteInput(input, 'envelope');
  if (inputLength > HEADER_BYTES + maxCiphertextBytes + TAG_BYTES) {
    throw new RangeError('envelope exceeds configured maximum');
  }
  const envelope = bytes(input, 'envelope');

  if (envelope.length < HEADER_BYTES + TAG_BYTES) {
    throw new Error('envelope is truncated');
  }
  if (!envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) throw new Error('envelope magic mismatch');
  if (envelope[4] !== FORMAT_VERSION) throw new Error('unsupported envelope format version');

  const mode = byteToMode(envelope[5]);
  const nonce = Buffer.from(envelope.subarray(6, 18));
  const ciphertextLength = envelope.readUInt32BE(18);
  if (ciphertextLength > maxCiphertextBytes) throw new RangeError('ciphertext exceeds configured maximum');

  const expectedLength = HEADER_BYTES + ciphertextLength + TAG_BYTES;
  if (envelope.length !== expectedLength) throw new Error('envelope length does not match declared ciphertext length');

  return Object.freeze({
    mode,
    nonce,
    ciphertext: Buffer.from(envelope.subarray(HEADER_BYTES, HEADER_BYTES + ciphertextLength)),
    tag: Buffer.from(envelope.subarray(HEADER_BYTES + ciphertextLength)),
    header: Buffer.from(envelope.subarray(0, HEADER_BYTES)),
    ciphertextLength,
    envelopeBytes: envelope.length
  });
}

/**
 * Seal bytes using AES-256-GCM.
 *
 * A durable, atomic nonceAllocator is mandatory. Its claim(keyFingerprint,
 * nonceHex) operation must reserve the nonce across all processes/devices
 * sharing the key and must never release a reservation, even if encryption
 * fails after the claim. The allocator must return true only for a new
 * reservation. This module intentionally provides no unsafe in-memory default.
 */
async function sealEnvelope(payloadInput, options) {
  const opts = options || {};
  const maxCiphertextBytes = validateMaxCiphertextBytes(opts.maxCiphertextBytes);
  const payloadLength = assertByteInput(payloadInput, 'payload');
  if (payloadLength > maxCiphertextBytes) throw new RangeError('payload exceeds configured maximum');

  const payload = bytes(payloadInput, 'payload');
  const key = validateKey(opts.key);
  const nonce = validateNonce(opts.nonce);
  const context = validateContext(opts.context);
  const mode = opts.mode;
  const modeByte = modeToByte(mode);
  const nonceAllocator = validateClaimProvider(opts.nonceAllocator, 'nonceAllocator');
  const keyFingerprint = fingerprint(key);
  const nonceHex = nonce.toString('hex');

  await requireNewClaim(nonceAllocator, 'nonceAllocator', keyFingerprint, nonceHex);

  const header = makeHeader(mode, nonce, payload.length);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([header, context]));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Guard against accidental divergence between the selected mode and header.
  if (header[5] !== modeByte) throw new Error('internal envelope mode mismatch');
  return Buffer.concat([header, ciphertext, tag]);
}

/**
 * Choose HFWBC1 only when its encoded bytes are strictly smaller than RAW.
 * The selected bytes are authenticated and encrypted by the same envelope.
 * This layer does not encode or decode HFWBC1 itself.
 */
async function sealWithRawFallback(rawInput, compressedInput, options) {
  const raw = bytes(rawInput, 'raw');
  const compressed = compressedInput === undefined || compressedInput === null
    ? null
    : bytes(compressedInput, 'compressed');
  const useCompressed = compressed !== null && compressed.length < raw.length;
  const mode = useCompressed ? 'hfwbc1' : 'raw';
  const payload = useCompressed ? compressed : raw;
  const envelope = await sealEnvelope(payload, { ...options, mode });
  return Object.freeze({
    mode,
    rawBytes: raw.length,
    compressedBytes: compressed === null ? null : compressed.length,
    selectedBytes: payload.length,
    envelope
  });
}

/**
 * Authenticate before returning plaintext, then atomically claim the
 * (key fingerprint, context fingerprint, nonce) tuple in a durable replay
 * guard. The replay guard must be shared by all consumers that process the
 * same key/context namespace. A duplicate claim is rejected before plaintext
 * is returned to the caller.
 */
async function openEnvelope(input, options) {
  const opts = options || {};
  const key = validateKey(opts.key);
  const context = validateContext(opts.context);
  const replayGuard = validateClaimProvider(opts.replayGuard, 'replayGuard');
  const parsed = parseEnvelope(input, opts);

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.concat([parsed.header, context]));
    decipher.setAuthTag(parsed.tag);
    plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch {
    throw new Error('AES-256-GCM authentication failed');
  }

  await requireNewClaim(
    replayGuard,
    'replayGuard',
    fingerprint(key),
    fingerprint(context),
    parsed.nonce.toString('hex')
  );

  return Object.freeze({ mode: parsed.mode, payload: plaintext });
}

module.exports = {
  get MAGIC() {
    return Buffer.from(ENVELOPE_MAGIC);
  },
  FORMAT_VERSION,
  MODE_RAW,
  MODE_HFWBC1,
  HEADER_BYTES,
  TAG_BYTES,
  NONCE_BYTES,
  KEY_BYTES,
  DEFAULT_MAX_CIPHERTEXT_BYTES,
  parseEnvelope,
  sealEnvelope,
  sealWithRawFallback,
  openEnvelope
};
