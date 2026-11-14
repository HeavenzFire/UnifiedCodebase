'use strict';

const OFFSETS = Object.freeze({
  MAGIC: [0, 6],
  VERSION: 6,
  TYPE: 7,
  WB_ID_TRUNC: [8, 24],
  FREQ_LEN: [24, 26],
  FREQ_C: [26, 32],
  RANS_LEN: [32, 36],
  RANS: [36, 46],
  BATCH_CRC: [46, 50],
  ACT_LEN: [50, 54],
  ACTIONS: [54, 304]
});

const WIRE_BYTES = 304;
const VERSION_V31 = 0x23;
const TYPE_BATCH = 0x01;
const EXPECTED_LENGTHS = Object.freeze({ freq: 6, rans: 10, actions: 250 });

function asBytes(value, name) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(name + ' must be a Buffer or Uint8Array');
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
  const bytes = asBytes(input, 'input');
  const opts = options || {};
  const expectedMagic = asBytes(opts.magic, 'options.magic');
  requireByteOrder(opts.integerByteOrder, 'options.integerByteOrder');
  requireByteOrder(opts.crcByteOrder, 'options.crcByteOrder');

  if (expectedMagic.length !== 6) throw new RangeError('options.magic must contain exactly 6 bytes');
  if (bytes.length !== WIRE_BYTES) throw new Error('wire length must be exactly ' + WIRE_BYTES + ' bytes');
  if (!bytes.subarray(0, 6).equals(expectedMagic)) throw new Error('magic mismatch');
  if (bytes[OFFSETS.VERSION] !== VERSION_V31) throw new Error('unsupported HFWBC version: expected 0x23');
  if (bytes[OFFSETS.TYPE] !== TYPE_BATCH) throw new Error('unsupported HFWBC record type: expected 0x01');

  const freqLength = readUnsigned(bytes, ...OFFSETS.FREQ_LEN, opts.integerByteOrder);
  const ransLength = readUnsigned(bytes, ...OFFSETS.RANS_LEN, opts.integerByteOrder);
  const actionsLength = readUnsigned(bytes, ...OFFSETS.ACT_LEN, opts.integerByteOrder);

  if (freqLength !== EXPECTED_LENGTHS.freq) throw new Error('FREQ_LEN must equal 6');
  if (ransLength !== EXPECTED_LENGTHS.rans) throw new Error('RANS_LEN must equal 10');
  if (actionsLength !== EXPECTED_LENGTHS.actions) throw new Error('ACT_LEN must equal 250');

  return Object.freeze({
    version: bytes[OFFSETS.VERSION],
    type: bytes[OFFSETS.TYPE],
    wbIdTrunc: Buffer.from(bytes.subarray(...OFFSETS.WB_ID_TRUNC)),
    freqLength,
    freqC: Buffer.from(bytes.subarray(...OFFSETS.FREQ_C)),
    ransLength,
    rans: Buffer.from(bytes.subarray(...OFFSETS.RANS)),
    batchCrc: readUnsigned(bytes, ...OFFSETS.BATCH_CRC, opts.crcByteOrder) >>> 0,
    actionsLength,
    actions: Buffer.from(bytes.subarray(...OFFSETS.ACTIONS)),
    wireBytes: bytes.length
  });
}

/**
 * Verify the v3.1 CRC coverage rule:
 * CRC32( canonical reconstructed state bytes || exact ACTIONS wire bytes ).
 * canonicalStatesBytes must already be produced by an independently
 * specified canonical state serializer; this function does not invent one.
 */
function verifyBatchCrc(parsedWire, canonicalStatesBytes) {
  if (!parsedWire || !Buffer.isBuffer(parsedWire.actions) || !Number.isInteger(parsedWire.batchCrc)) {
    throw new TypeError('parsedWire must be the result of parseWireV31');
  }
  const states = asBytes(canonicalStatesBytes, 'canonicalStatesBytes');
  const actual = crc32Ieee(Buffer.concat([states, parsedWire.actions]));
  return Object.freeze({
    ok: actual === (parsedWire.batchCrc >>> 0),
    expected: parsedWire.batchCrc >>> 0,
    actual
  });
}

module.exports = {
  OFFSETS,
  WIRE_BYTES,
  VERSION_V31,
  TYPE_BATCH,
  EXPECTED_LENGTHS,
  crc32Ieee,
  parseWireV31,
  verifyBatchCrc
};
