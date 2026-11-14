'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OFFSETS,
  WIRE_BYTES,
  crc32Ieee,
  parseWireV31,
  verifyBatchCrc
} = require('./hfwbc1-v3_1-audit.cjs');

const MAGIC = Buffer.from('TEST01', 'ascii'); // Test-only sentinel; not the production HFWBC magic.
const BYTE_ORDER = 'little';
const CRC_ORDER = 'big';

function writeUInt(buffer, start, end, value, order) {
  const width = end - start;
  let n = BigInt(value);
  for (let i = 0; i < width; i += 1) {
    const at = order === 'little' ? start + i : end - 1 - i;
    buffer[at] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function fixture(states) {
  const wire = Buffer.alloc(WIRE_BYTES);
  MAGIC.copy(wire, 0);
  wire[6] = 0x23;
  wire[7] = 0x01;
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(wire, 8);
  writeUInt(wire, 24, 26, 6, BYTE_ORDER);
  Buffer.from('0200ff1f0e01', 'hex').copy(wire, 26);
  writeUInt(wire, 32, 36, 10, BYTE_ORDER);
  Buffer.from('8be15c85d32592e37426', 'hex').copy(wire, 36);
  writeUInt(wire, 50, 54, 250, BYTE_ORDER);
  for (let i = 54; i < 304; i += 1) wire[i] = (i * 29) & 0xff;
  const crcInput = Buffer.concat([states, wire.subarray(54, 304)]);
  writeUInt(wire, 46, 50, crc32Ieee(crcInput), CRC_ORDER);
  return wire;
}

function parse(wire) {
  return parseWireV31(wire, {
    magic: MAGIC,
    integerByteOrder: BYTE_ORDER,
    crcByteOrder: CRC_ORDER
  });
}

test('CRC-32/ISO-HDLC matches the published check value', () => {
  assert.equal(crc32Ieee(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

test('parses the fixed 304-byte v3.1 envelope without claiming state decode', () => {
  const states = Buffer.from('canonical-state-fixture', 'utf8');
  const parsed = parse(fixture(states));
  assert.equal(parsed.wireBytes, 304);
  assert.equal(parsed.version, 0x23);
  assert.equal(parsed.type, 0x01);
  assert.equal(parsed.wbIdTrunc.length, 16);
  assert.equal(parsed.freqC.length, 6);
  assert.equal(parsed.rans.length, 10);
  assert.equal(parsed.actions.length, 250);
  assert.equal(OFFSETS.ACTIONS[0], 54);
  assert.equal(OFFSETS.ACTIONS[1], 304);
});

test('v3.1 CRC verifies states followed by exact ACTIONS bytes', () => {
  const states = Buffer.from('canonical-state-fixture', 'utf8');
  const wire = fixture(states);
  assert.deepEqual(verifyBatchCrc(parse(wire), states), {
    ok: true,
    expected: crc32Ieee(Buffer.concat([states, wire.subarray(54, 304)])),
    actual: crc32Ieee(Buffer.concat([states, wire.subarray(54, 304)]))
  });
});

test('changing one ACTIONS byte invalidates the v3.1 batch CRC', () => {
  const states = Buffer.from('canonical-state-fixture', 'utf8');
  const wire = fixture(states);
  wire[149] ^= 0x01;
  const result = verifyBatchCrc(parse(wire), states);
  assert.equal(result.ok, false);
  assert.notEqual(result.actual, result.expected);
});

test('changing reconstructed-state bytes invalidates the v3.1 batch CRC', () => {
  const states = Buffer.from('canonical-state-fixture', 'utf8');
  const wire = fixture(states);
  const changedStates = Buffer.from(states);
  changedStates[0] ^= 0x01;
  assert.equal(verifyBatchCrc(parse(wire), changedStates).ok, false);
});

test('rejects truncated and trailing-byte records', () => {
  const wire = fixture(Buffer.from('state'));
  assert.throws(() => parse(wire.subarray(0, 303)), /exactly 304/);
  assert.throws(() => parse(Buffer.concat([wire, Buffer.from([0])])), /exactly 304/);
});

test('rejects wrong magic, v3 version, and unknown type', () => {
  const wire = fixture(Buffer.from('state'));
  const wrongMagic = Buffer.from(wire);
  wrongMagic[0] ^= 0x01;
  assert.throws(() => parse(wrongMagic), /magic mismatch/);
  const v3 = Buffer.from(wire);
  v3[6] = 0x22;
  assert.throws(() => parse(v3), /version/);
  const wrongType = Buffer.from(wire);
  wrongType[7] = 0x02;
  assert.throws(() => parse(wrongType), /record type/);
});

test('rejects inconsistent declared field lengths', () => {
  const wire = fixture(Buffer.from('state'));
  writeUInt(wire, 50, 54, 249, BYTE_ORDER);
  assert.throws(() => parse(wire), /ACT_LEN/);
});

test('requires explicit magic and integer byte-order declarations', () => {
  const wire = fixture(Buffer.from('state'));
  assert.throws(() => parseWireV31(wire, { magic: MAGIC, crcByteOrder: CRC_ORDER }), /integerByteOrder/);
  assert.throws(() => parseWireV31(wire, { integerByteOrder: BYTE_ORDER, crcByteOrder: CRC_ORDER }), /options.magic/);
});
