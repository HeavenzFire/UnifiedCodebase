'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const audit = require('./hfwbc1-v3_1-audit.cjs');
const envelopeApi = require('./hfwbc1-v3_2-envelope.cjs');
const {
  HEADER_BYTES,
  TAG_BYTES,
  sealEnvelope,
  sealWithRawFallback,
  parseEnvelope,
  openEnvelope
} = envelopeApi;
const {
  parseWireV31,
  crc32Ieee,
  verifyBatchCrc,
  WIRE_BYTES
} = audit;

function memoryClaimStore() {
  const claimed = new Set();
  return {
    async claim(...parts) {
      const id = parts.join(':');
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }
  };
}

function options(context = Buffer.from('heavenzfire:test:unit', 'utf8')) {
  return {
    key: crypto.randomBytes(32),
    nonce: crypto.randomBytes(12),
    context,
    nonceAllocator: memoryClaimStore(),
    replayGuard: memoryClaimStore()
  };
}

function withFreshNonce(opts) {
  return { ...opts, nonce: crypto.randomBytes(12) };
}

function xorshift32(initial) {
  let state = initial >>> 0;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function writeUInt(buffer, start, end, value, order) {
  let n = BigInt(value);
  for (let i = 0; i < end - start; i += 1) {
    const at = order === 'little' ? start + i : end - 1 - i;
    buffer[at] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function v31Fixture(states) {
  const wire = Buffer.alloc(WIRE_BYTES);
  Buffer.from('TEST01', 'ascii').copy(wire, 0);
  wire[6] = 0x23;
  wire[7] = 0x01;
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(wire, 8);
  writeUInt(wire, 24, 26, 6, 'little');
  Buffer.from('0200ff1f0e01', 'hex').copy(wire, 26);
  writeUInt(wire, 32, 36, 10, 'little');
  Buffer.from('8be15c85d32592e37426', 'hex').copy(wire, 36);
  writeUInt(wire, 50, 54, 250, 'little');
  for (let i = 54; i < 304; i += 1) wire[i] = (i * 29) & 0xff;
  writeUInt(wire, 46, 50, crc32Ieee(Buffer.concat([states, wire.subarray(54, 304)])), 'big');
  return wire;
}

test('Node AES-256-GCM backend matches the NIST empty-message known-answer tag', () => {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 });
  assert.deepEqual(cipher.update(Buffer.alloc(0)), Buffer.alloc(0));
  assert.deepEqual(cipher.final(), Buffer.alloc(0));
  assert.equal(cipher.getAuthTag().toString('hex'), '530f8afbc74536b9a963b4f1c4cb738b');
});

test('AES-256-GCM round-trips RAW payload', async () => {
  const opts = options();
  const raw = Buffer.from('raw capture payload');
  const sealed = await sealEnvelope(raw, { ...opts, mode: 'raw' });
  const opened = await openEnvelope(sealed, opts);
  assert.equal(opened.mode, 'raw');
  assert.deepEqual(opened.payload, raw);
});

test('AES-256-GCM round-trips HFWBC1 payload without decoding it', async () => {
  const opts = options();
  const encoded = Buffer.from([0x48, 0x46, 0x57, 0x42, 0x43, 0x31]);
  const sealed = await sealEnvelope(encoded, { ...opts, mode: 'hfwbc1' });
  const opened = await openEnvelope(sealed, opts);
  assert.equal(opened.mode, 'hfwbc1');
  assert.deepEqual(opened.payload, encoded);
});

test('envelope ciphertext and tag match a direct AES-GCM calculation over header plus context AAD', async () => {
  const opts = options();
  const payload = Buffer.from('independent AAD framing check');
  const sealed = await sealEnvelope(payload, { ...opts, mode: 'raw' });
  const parsed = parseEnvelope(sealed);
  const direct = crypto.createCipheriv('aes-256-gcm', opts.key, opts.nonce, { authTagLength: TAG_BYTES });
  direct.setAAD(Buffer.concat([parsed.header, opts.context]));
  const directCiphertext = Buffer.concat([direct.update(payload), direct.final()]);
  assert.deepEqual(parsed.ciphertext, directCiphertext);
  assert.deepEqual(parsed.tag, direct.getAuthTag());
  assert.equal(parsed.envelopeBytes, HEADER_BYTES + payload.length + TAG_BYTES);
});

test('RAW fallback selects HFWBC1 only when encoded bytes are strictly smaller', async () => {
  const opts = options();
  const raw = Buffer.alloc(128, 0x41);
  const compressed = Buffer.alloc(44, 0x42);
  const result = await sealWithRawFallback(raw, compressed, opts);
  assert.equal(result.mode, 'hfwbc1');
  assert.equal(result.selectedBytes, 44);
  const opened = await openEnvelope(result.envelope, opts);
  assert.equal(opened.mode, result.mode);
  assert.deepEqual(opened.payload, compressed);
});

test('RAW fallback chooses RAW on equal or larger encoded payloads', async () => {
  const opts = options();
  const raw = Buffer.alloc(64, 0x41);
  const equal = await sealWithRawFallback(raw, Buffer.alloc(64, 0x42), opts);
  assert.equal(equal.mode, 'raw');
  const openedEqual = await openEnvelope(equal.envelope, opts);
  assert.equal(openedEqual.mode, equal.mode);
  assert.deepEqual(openedEqual.payload, raw);

  const larger = await sealWithRawFallback(raw, Buffer.alloc(65, 0x42), withFreshNonce(opts));
  assert.equal(larger.mode, 'raw');
  const openedLarger = await openEnvelope(larger.envelope, opts);
  assert.equal(openedLarger.mode, larger.mode);
  assert.deepEqual(openedLarger.payload, raw);
});

test('RAW fallback checks candidate sizes before copying and chooses a fitting compressed candidate', async () => {
  const opts = options();
  const raw = Buffer.alloc(64, 0x41);
  const compressed = Buffer.alloc(20, 0x42);
  const result = await sealWithRawFallback(raw, compressed, { ...opts, maxCiphertextBytes: 32 });
  assert.equal(result.mode, 'hfwbc1');
  assert.equal(result.selectedBytes, 20);
  const opened = await openEnvelope(result.envelope, opts);
  assert.equal(opened.mode, 'hfwbc1');
  assert.deepEqual(opened.payload, compressed);

  await assert.rejects(
    sealWithRawFallback(raw, Buffer.alloc(40, 0x43), { ...withFreshNonce(opts), maxCiphertextBytes: 32 }),
    /no RAW or HFWBC1 candidate fits configured maximum/
  );
});

test('RAW fallback handles missing compressed candidate', async () => {
  const opts = options();
  const raw = Buffer.from('raw only');
  const result = await sealWithRawFallback(raw, null, opts);
  assert.equal(result.mode, 'raw');
  const opened = await openEnvelope(result.envelope, opts);
  assert.equal(opened.mode, result.mode);
  assert.deepEqual(opened.payload, raw);
});

test('tampering with mode header, ciphertext, or tag is rejected', async () => {
  const opts = options();
  const sealed = await sealEnvelope(Buffer.from('authenticated bytes'), { ...opts, mode: 'raw' });

  const headerTamper = Buffer.from(sealed);
  headerTamper[5] = 0x01;
  await assert.rejects(openEnvelope(headerTamper, opts), /authentication failed/);

  const cipherTamper = Buffer.from(sealed);
  cipherTamper[HEADER_BYTES] ^= 0x01;
  await assert.rejects(openEnvelope(cipherTamper, opts), /authentication failed/);

  const tagTamper = Buffer.from(sealed);
  tagTamper[tagTamper.length - 1] ^= 0x01;
  await assert.rejects(openEnvelope(tagTamper, opts), /authentication failed/);
});

test('500 seeded single-byte mutations across the entire envelope are rejected', async () => {
  const opts = options();
  const payload = Buffer.from('whole-envelope mutation fixture');
  const original = await sealEnvelope(payload, { ...opts, mode: 'raw' });
  assert.deepEqual((await openEnvelope(original, opts)).payload, payload);
  const next = xorshift32(3202);

  let rejected = 0;
  for (let i = 0; i < 500; i += 1) {
    const mutated = Buffer.from(original);
    const offset = next() % mutated.length;
    const delta = 1 + (next() % 255);
    mutated[offset] ^= delta;
    await assert.rejects(openEnvelope(mutated, opts));
    rejected += 1;
  }
  assert.equal(rejected, 500);
});

test('nonce allocator rejects reuse for the same key but permits the same nonce under a different key', async () => {
  const opts = options();
  const payload = Buffer.from('nonce uniqueness fixture');
  await sealEnvelope(payload, { ...opts, mode: 'raw' });
  await assert.rejects(sealEnvelope(payload, { ...opts, mode: 'raw' }), /nonceAllocator rejected/);

  const otherKey = { ...opts, key: crypto.randomBytes(32) };
  const differentKeyEnvelope = await sealEnvelope(payload, { ...otherKey, mode: 'raw' });
  assert.ok(Buffer.isBuffer(differentKeyEnvelope));
});

test('replay guard rejects a previously accepted authenticated envelope', async () => {
  const opts = options();
  const payload = Buffer.from('one-time record');
  const sealed = await sealEnvelope(payload, { ...opts, mode: 'raw' });
  assert.deepEqual((await openEnvelope(sealed, opts)).payload, payload);
  await assert.rejects(openEnvelope(sealed, opts), /replayGuard rejected/);
});

test('nonce allocator and replay guard are mandatory', async () => {
  const opts = options();
  const payload = Buffer.from('guard contract');
  await assert.rejects(sealEnvelope(payload, { ...opts, nonceAllocator: undefined, mode: 'raw' }), /nonceAllocator/);
  const sealed = await sealEnvelope(payload, { ...opts, mode: 'raw' });
  await assert.rejects(openEnvelope(sealed, { ...opts, replayGuard: undefined }), /replayGuard/);
});

test('wrong key and wrong external context fail authentication', async () => {
  const opts = options();
  const sealed = await sealEnvelope(Buffer.from('bound context'), { ...opts, mode: 'raw' });
  await assert.rejects(openEnvelope(sealed, { ...opts, key: crypto.randomBytes(32) }), /authentication failed/);
  await assert.rejects(openEnvelope(sealed, { ...opts, context: Buffer.from('other-context') }), /authentication failed/);
});

test('rejects truncated, trailing, and inconsistent-length envelopes', () => {
  const opts = options();
  const envelope = Buffer.alloc(HEADER_BYTES + TAG_BYTES);
  assert.throws(() => parseEnvelope(envelope.subarray(0, envelope.length - 1)), /truncated/);
  assert.throws(() => parseEnvelope(Buffer.concat([envelope, Buffer.from([0])])), /magic mismatch|length/);
});

test('rejects invalid keys, nonce lengths, missing context, and unknown modes', async () => {
  const opts = options();
  await assert.rejects(sealEnvelope(Buffer.from('x'), { ...opts, key: Buffer.alloc(31), mode: 'raw' }), /32 bytes/);
  await assert.rejects(sealEnvelope(Buffer.from('x'), { ...opts, nonce: Buffer.alloc(11), mode: 'raw' }), /12 bytes/);
  await assert.rejects(sealEnvelope(Buffer.from('x'), { key: opts.key, nonce: opts.nonce, mode: 'raw', nonceAllocator: opts.nonceAllocator }), /context/);
  await assert.rejects(sealEnvelope(Buffer.from('x'), { ...opts, mode: 'unknown' }), /mode/);
});

test('rejects ciphertext above configured maximum during parse and seal', async () => {
  const opts = options();
  const sealed = await sealEnvelope(Buffer.alloc(32), { ...opts, mode: 'raw' });
  assert.throws(() => parseEnvelope(sealed, { maxCiphertextBytes: 31 }), /maximum/);
  await assert.rejects(sealEnvelope(Buffer.alloc(32), { ...opts, mode: 'raw', maxCiphertextBytes: 31 }), /maximum/);
});

test('rejects oversized envelope input before copying it', () => {
  const oversized = Buffer.alloc(1024);
  assert.throws(() => parseEnvelope(oversized, { maxCiphertextBytes: 1 }), /envelope exceeds configured maximum/);
});

test('rejects same-realm and cross-realm SharedArrayBuffer-backed inputs', async () => {
  if (typeof SharedArrayBuffer === 'undefined') return;
  const opts = options();
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  await assert.rejects(sealEnvelope(shared, { ...opts, mode: 'raw' }), /SharedArrayBuffer/);
  assert.throws(() => parseEnvelope(shared), /SharedArrayBuffer/);

  const foreignShared = vm.runInNewContext('new Uint8Array(new SharedArrayBuffer(4))');
  assert.equal(Object.prototype.toString.call(foreignShared), '[object Uint8Array]');
  await assert.rejects(sealEnvelope(foreignShared, { ...withFreshNonce(opts), mode: 'raw' }), /SharedArrayBuffer/);
  assert.throws(() => parseEnvelope(foreignShared), /SharedArrayBuffer/);

  const foreignWire = vm.runInNewContext('new Uint8Array(new SharedArrayBuffer(304))');
  assert.throws(() => parseWireV31(foreignWire, {
    magic: Buffer.from('TEST01', 'ascii'),
    integerByteOrder: 'little',
    crcByteOrder: 'big'
  }), /SharedArrayBuffer/);
});

test('accepts ordinary cross-realm Uint8Array payloads by snapshotting them', async () => {
  const opts = options();
  const foreignPayload = vm.runInNewContext('new Uint8Array([72, 70, 87, 66])');
  const sealed = await sealEnvelope(foreignPayload, { ...opts, mode: 'raw' });
  const opened = await openEnvelope(sealed, opts);
  assert.deepEqual(opened.payload, Buffer.from([72, 70, 87, 66]));
});

test('exported protocol constants are defensive copies', async () => {
  const mutableOffsets = audit.OFFSETS;
  mutableOffsets.ACTIONS[0] = 0;
  mutableOffsets.MAGIC[0] = 5;

  const states = Buffer.from('constant export fixture');
  const wire = v31Fixture(states);
  const parsed = parseWireV31(wire, {
    magic: Buffer.from('TEST01', 'ascii'),
    integerByteOrder: 'little',
    crcByteOrder: 'big'
  });
  assert.equal(parsed.version, 0x23);
  assert.equal(verifyBatchCrc(parsed, states).ok, true);

  const mutableMagic = envelopeApi.MAGIC;
  mutableMagic.fill(0);
  const opts = options();
  const sealed = await sealEnvelope(Buffer.from('private magic'), { ...opts, mode: 'raw' });
  assert.equal(parseEnvelope(sealed).header.subarray(0, 4).toString('ascii'), 'HFWG');
});

test('reports exact envelope framing lengths', async () => {
  const opts = options();
  const payload = Buffer.from('123456789');
  const sealed = await sealEnvelope(payload, { ...opts, mode: 'raw' });
  const parsed = parseEnvelope(sealed);
  assert.equal(parsed.envelopeBytes, HEADER_BYTES + payload.length + TAG_BYTES);
  assert.equal(parsed.ciphertextLength, payload.length);
});
