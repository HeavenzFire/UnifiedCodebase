'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crc32Ieee, parseWireV31, verifyBatchCrc, WIRE_BYTES } = require('./hfwbc1-v3_1-audit.cjs');

const MAGIC = Buffer.from('TEST01', 'ascii'); // Test-only sentinel; not the production HFWBC magic.
const STATES = Buffer.from('canonical-state-fixture', 'utf8');

function writeUInt(buffer, start, end, value, order) {
  let n = BigInt(value);
  for (let i = 0; i < end - start; i += 1) {
    const at = order === 'little' ? start + i : end - 1 - i;
    buffer[at] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function makeFixture() {
  const wire = Buffer.alloc(WIRE_BYTES);
  MAGIC.copy(wire, 0);
  wire[6] = 0x23;
  wire[7] = 0x01;
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(wire, 8);
  writeUInt(wire, 24, 26, 6, 'little');
  Buffer.from('0200ff1f0e01', 'hex').copy(wire, 26);
  writeUInt(wire, 32, 36, 10, 'little');
  Buffer.from('8be15c85d32592e37426', 'hex').copy(wire, 36);
  writeUInt(wire, 50, 54, 250, 'little');
  for (let i = 54; i < 304; i += 1) wire[i] = (i * 29) & 0xff;
  const crc = crc32Ieee(Buffer.concat([STATES, wire.subarray(54, 304)]));
  writeUInt(wire, 46, 50, crc, 'big');
  return wire;
}

function parse(wire) {
  return parseWireV31(wire, {
    magic: MAGIC,
    integerByteOrder: 'little',
    crcByteOrder: 'big'
  });
}

function makeXorShift32(initial) {
  let state = initial >>> 0;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test('seed-999: 500 independent single-byte ACTIONS mutations are all rejected by CRC', () => {
  const original = makeFixture();
  assert.equal(verifyBatchCrc(parse(original), STATES).ok, true);

  const next = makeXorShift32(999);
  let hardFails = 0;
  for (let i = 0; i < 500; i += 1) {
    const mutated = Buffer.from(original);
    const offset = 54 + (next() % 250);
    const delta = 1 + (next() % 255);
    mutated[offset] ^= delta;

    const parsed = parse(mutated);
    const result = verifyBatchCrc(parsed, STATES);
    if (!result.ok) hardFails += 1;
  }

  assert.equal(hardFails, 500);
});
