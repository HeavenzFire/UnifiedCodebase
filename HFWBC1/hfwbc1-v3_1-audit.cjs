'use strict';

const INTERNAL_OFFSETS = Object.freeze({
  MAGIC: Object.freeze([0, 6]),
  VERSION: 6,
  TYPE: 7,
  WB_ID_TRUNC: Object.freeze([8, 24]),
  FREQ_LEN: Object.freeze([24, 26]),
  FREQ_C: Object.freeze([26, 32]),
  RANS_LEN: Object.freeze([32, 36]),
  RANS: Object.freeze([36, 46]),
  BATCH_CRC: Object.freeze([46, 50]),
  ACT_LEN: Object.freeze([50, 54]),
  ACTIONS: Object.freeze([54, 304])
});

const WIRE_BYTES = 304;
const VERSION_V31 = 0x23;
const TYPE_BATCH = 0x01;
const EXPECTED_LENGTHS = Object.freeze({ freq: 6, rans: 10, actions: 250 });

// The WeakMap proves parser provenance and keeps verification bytes private
// from callers who may mutate the public Buffer copies returned by the parser.
const PARSED_WIRE_DATA = new WeakMap();

function publicOffsets() {
  return Object.fromEntries(Object.entries(INTERNAL_OFFSETS).map(([name, value]) => [
    name,
    Array.isArray(value) ? [...value] : value
  ]));
}

function asBytes(value, name) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(name + ' must be a Buffer or Uint8Array');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(name + ' must not use SharedArrayBuffer backing');
  }
  // Copy to a private snapshot so later writes through the caller's view
  // cannot change bytes after validation.
  return Buffer.from(value);
}

function requireByteOrder(value, name) {
  if (value !== 'little' && value !== 'big') {
    throw new TypeError(name + ' must be explicitly set to "little" or "big"');
  }
}

function readUnsigned(bytes, start, end, order) {
  const width = end - start;
  let value = 0n;
  if (order === 'little') {
    for (let i = width - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[start + i]);
  } else {
    for (let i = start; i < end; i += 1) value = (value << 8n) | BigInt(bytes[i]);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('integer field exceeds JavaScript safe integer range');
  return Number(value);
}

function crc32Ieee(input) {
  const bytes = asBytes(input, 'input');
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Parse only the fixed v3.1 wire envelope. This does not decode rANS, rebuild
 * states, validate ACTIONS JSON semantics, or establish compression ratios.
 * The protocol report supplied so far does not specify the magic bytes or
 * integer byte order, so callers must supply those explicitly.
 */
function parseWireV31(input, options) {
  if ((!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) || input.byteLength !== WIRE_BYTES) {
    if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
      throw new TypeError('input must be a Buffer or Uint8Array');
    }
    throw new Error('wire length must be exactly ' + WIRE_BYTES + ' bytes');
  }
  const bytes = asBytes(input, 'input');
  const opts = options || {};
  const expectedMagic = asBytes(opts.magic, 'options.magic');
  requireByteOrder(opts.integerByteOrder, 'options.integerByteOrder');
  requireByteOrder(opts.crcByteOrder, 'options.crcByteOrder');

  if (expectedMagic.length !== 6) throw new RangeError('options.magic must contain exactly 6 bytes');
  if (!bytes.subarray(...INTERNAL_OFFSETS.MAGIC).equals(expectedMagic)) throw new Error('magic mismatch');
  if (bytes[INTERNAL_OFFSETS.VERSION] !== VERSION_V31) throw new Error('unsupported HFWBC version: expected 0x23');
  if (bytes[INTERNAL_OFFSETS.TYPE] !== TYPE_BATCH) throw new Error('unsupported HFWBC record type: expected 0x01');

  const freqLength = readUnsigned(bytes, ...INTERNAL_OFFSETS.FREQ_LEN, opts.integerByteOrder);
  const ransLength = readUnsigned(bytes, ...INTERNAL_OFFSETS.RANS_LEN, opts.integerByteOrder);
  const actionsLength = readUnsigned(bytes, ...INTERNAL_OFFSETS.ACT_LEN, opts.integerByteOrder);

  if (freqLength !== EXPECTED_LENGTHS.freq) throw new Error('FREQ_LEN must equal 6');
  if (ransLength !== EXPECTED_LENGTHS.rans) throw new Error('RANS_LEN must equal 10');
  if (actionsLength !== EXPECTED_LENGTHS.actions) throw new Error('ACT_LEN must equal 250');

  const batchCrc = readUnsigned(bytes, ...INTERNAL_OFFSETS.BATCH_CRC, opts.crcByteOrder) >>> 0;
  const actions = Buffer.from(bytes.subarray(...INTERNAL_OFFSETS.ACTIONS));
  const result = Object.freeze({
    version: bytes[INTERNAL_OFFSETS.VERSION],
    type: bytes[INTERNAL_OFFSETS.TYPE],
    wbIdTrunc: Buffer.from(bytes.subarray(...INTERNAL_OFFSETS.WB_ID_TRUNC)),
    freqLength,
    freqC: Buffer.from(bytes.subarray(...INTERNAL_OFFSETS.FREQ_C)),
    ransLength,
    rans: Buffer.from(bytes.subarray(...INTERNAL_OFFSETS.RANS)),
    batchCrc,
    actionsLength,
    actions: Buffer.from(actions),
    wireBytes: bytes.length
  });

  PARSED_WIRE_DATA.set(result, Object.freeze({
    actions,
    batchCrc
  }));
  return result;
}

/**
 * Verify the v3.1 CRC coverage rule:
 * CRC32( canonical reconstructed state bytes || exact ACTIONS wire bytes ).
 * canonicalStatesBytes must already be produced by an independently
 * specified canonical state serializer; this function does not invent one.
 * Only an object returned by parseWireV31 is accepted. Verification uses
 * private parser snapshots, not mutable public Buffer fields.
 */
function verifyBatchCrc(parsedWire, canonicalStatesBytes) {
  const trusted = parsedWire && PARSED_WIRE_DATA.get(parsedWire);
  if (!trusted) {
    throw new TypeError('parsedWire must be an unmodified parser-issued result from parseWireV31');
  }
  const states = asBytes(canonicalStatesBytes, 'canonicalStatesBytes');
  const actual = crc32Ieee(Buffer.concat([states, trusted.actions]));
  return Object.freeze({
    ok: actual === (trusted.batchCrc >>> 0),
    expected: trusted.batchCrc >>> 0,
    actual
  });
}

module.exports = {
  get OFFSETS() {
    return publicOffsets();
  },
  WIRE_BYTES,
  VERSION_V31,
  TYPE_BATCH,
  EXPECTED_LENGTHS,
  crc32Ieee,
  parseWireV31,
  verifyBatchCrc
};
