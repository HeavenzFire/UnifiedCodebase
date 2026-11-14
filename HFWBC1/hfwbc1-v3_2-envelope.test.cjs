'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  HEADER_BYTES,
  TAG_BYTES,
  sealEnvelope,
  sealWithRawFallback,
  parseEnvelope,
  openEnvelope
} = require('./hfwbc1-v3_2-envelope.cjs');

function options(context = Buffer.from('heavenzfire:test:unit', 'utf8')) {
  return {
    key: crypto.randomBytes(32),
    nonce: crypto.randomBytes(12),
    context
  };
}

test('AES-256-GCM round-trips RAW payload', () => {
  const opts = options();
  const raw = Buffer.from('raw capture payload');
  const envelope = sealEnvelope(raw, { ...opts, mode: 'raw' });
  const opened = openEnvelope(envelope, opts);
  assert.equal(opened.mode, 'raw');
  assert.deepEqual(opened.payload, raw);
});

test('AES-256-GCM round-trips HFWBC1 payload without decoding it', () => {
  const opts = options();
  const encoded = Buffer.from([0x48, 0x46, 0x57, 0x42, 0x43, 0x31]);
  const envelope = sealEnvelope(encoded, { ...opts, mode: 'hfwbc1' });
  const opened = openEnvelope(envelope, opts);
  assert.equal(opened.mode, 'hfwbc1');
  assert.deepEqual(opened.payload, encoded);
});

test('RAW fallback selects HFWBC1 only when encoded bytes are strictly smaller', () => {
  const opts = options();
  const raw = Buffer.alloc(128, 0x41);
  const compressed = Buffer.alloc(44, 0x42);
  const result = sealWithRawFallback(raw, compressed, opts);
  assert.equal(result.mode, 'hfwbc1');
  assert.equal(result.selectedBytes, 44);
  assert.deepEqual(openEnvelope(result.envelope, opts).payload, compressed);
});

test('RAW fallback chooses RAW on equal or larger encoded payloads', () => {
  const opts = options();
  const raw = Buffer.alloc(64, 0x41);
  const equal = sealWithRawFallback(raw, Buffer.alloc(64, 0x42), opts);
  assert.equal(equal.mode, 'raw');
  assert.deepEqual(openEnvelope(equal.envelope, opts).payload, raw);

  const larger = sealWithRawFallback(raw, Buffer.alloc(65, 0x42), opts);
  assert.equal(larger.mode, 'raw');
  assert.deepEqual(openEnvelope(larger.envelope, opts).payload, raw);
});

test('RAW fallback handles missing compressed candidate', () => {
  const opts = options();
  const raw = Buffer.from('raw only');
  const result = sealWithRawFallback(raw, null, opts);
  assert.equal(result.mode, 'raw');
  assert.deepEqual(openEnvelope(result.envelope, opts).payload, raw);
});

test('tampering with mode header, ciphertext, or tag is rejected', () => {
  const opts = options();
  const envelope = sealEnvelope(Buffer.from('authenticated bytes'), { ...opts, mode: 'raw' });

  const headerTamper = Buffer.from(envelope);
  headerTamper[5] = 0x01;
  assert.throws(() => openEnvelope(headerTamper, opts), /authentication failed/);

  const cipherTamper = Buffer.from(envelope);
  cipherTamper[HEADER_BYTES] ^= 0x01;
  assert.throws(() => openEnvelope(cipherTamper, opts), /authentication failed/);

  const tagTamper = Buffer.from(envelope);
  tagTamper[tagTamper.length - 1] ^= 0x01;
  assert.throws(() => openEnvelope(tagTamper, opts), /authentication failed/);
});

test('wrong key and wrong external context fail authentication', () => {
  const opts = options();
  const envelope = sealEnvelope(Buffer.from('bound context'), { ...opts, mode: 'raw' });
  assert.throws(() => openEnvelope(envelope, { ...opts, key: crypto.randomBytes(32) }), /authentication failed/);
  assert.throws(() => openEnvelope(envelope, { ...opts, context: Buffer.from('other-context') }), /authentication failed/);
});

test('rejects truncated, trailing, and inconsistent-length envelopes', () => {
  const opts = options();
  const envelope = sealEnvelope(Buffer.from('payload'), { ...opts, mode: 'raw' });
  assert.throws(() => parseEnvelope(envelope.subarray(0, envelope.length - 1)), /length/);
  assert.throws(() => parseEnvelope(Buffer.concat([envelope, Buffer.from([0])])), /length/);

  const badLength = Buffer.from(envelope);
  badLength.writeUInt32BE(99, 18);
  assert.throws(() => parseEnvelope(badLength), /length/);
});

test('rejects invalid keys, nonce lengths, missing context, and unknown modes', () => {
  const opts = options();
  assert.throws(() => sealEnvelope(Buffer.from('x'), { ...opts, key: Buffer.alloc(31), mode: 'raw' }), /32 bytes/);
  assert.throws(() => sealEnvelope(Buffer.from('x'), { ...opts, nonce: Buffer.alloc(11), mode: 'raw' }), /12 bytes/);
  assert.throws(() => sealEnvelope(Buffer.from('x'), { key: opts.key, nonce: opts.nonce, mode: 'raw' }), /context/);
  assert.throws(() => sealEnvelope(Buffer.from('x'), { ...opts, mode: 'unknown' }), /mode/);
});

test('rejects ciphertext above configured maximum', () => {
  const opts = options();
  const envelope = sealEnvelope(Buffer.alloc(32), { ...opts, mode: 'raw' });
  assert.throws(() => parseEnvelope(envelope, { maxCiphertextBytes: 31 }), /maximum/);
});

test('reports exact envelope framing lengths', () => {
  const opts = options();
  const payload = Buffer.from('123456789');
  const envelope = sealEnvelope(payload, { ...opts, mode: 'raw' });
  const parsed = parseEnvelope(envelope);
  assert.equal(parsed.envelopeBytes, HEADER_BYTES + payload.length + TAG_BYTES);
  assert.equal(parsed.ciphertextLength, payload.length);
});
