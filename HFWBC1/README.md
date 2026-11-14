# HFWBC1 v3.1 independent audit layer

**Status: structural/CRC audit scaffold; not a complete HFWBC encoder or decoder.**

This module is deliberately narrower than the reported v3.1 implementation. It independently checks the fixed 304-byte envelope and the reported CRC coverage rule:

`CRC32(canonical reconstructed state bytes || exact ACTIONS wire bytes)`

It does not reconstruct the 300-state sequence, decode rANS, parse or canonicalize ACTIONS JSON, prove baseline conditioning, or reproduce the reported 500/500 fuzz result.

## Fixed wire layout used by this audit

| Field | Byte range | Width |
|---|---:|---:|
| MAGIC | 0–5 | 6 |
| VER | 6 | 1 |
| TYPE | 7 | 1 |
| WB_ID_TRUNC | 8–23 | 16 |
| FREQ_LEN | 24–25 | 2 |
| FREQ_C | 26–31 | 6 |
| RANS_LEN | 32–35 | 4 |
| RANS | 36–45 | 10 |
| BATCH_CRC | 46–49 | 4 |
| ACT_LEN | 50–53 | 4 |
| ACTIONS | 54–303 | 250 |
| Total | 0–303 | 304 |

Version is 0x23 and record type is 0x01. The parser requires callers to supply the six magic bytes and the integer/CRC byte order explicitly because neither is established by the available report. The test-only magic `TEST01` is not a production magic value.

## Run

```powershell
node --test .\HFWBC1\hfwbc1-v3_1-audit.test.cjs
```

No external npm packages are required.

## What the tests establish

- The CRC implementation matches the CRC-32/ISO-HDLC check value for `123456789`.
- Fixed field offsets and widths are enforced for synthetic test fixtures.
- The CRC verifier hashes reconstructed-state bytes followed by the exact ACTIONS bytes.
- Mutating ACTIONS or reconstructed-state bytes invalidates the fixture CRC.
- Wrong versions, types, magic, lengths, truncation, trailing bytes, and unspecified byte-order options are rejected.

These are tests of this audit module and synthetic fixtures, not tests of the missing production HFWBC1 v3.1 artifact.

## Missing production evidence

The following inputs are still required before full independent decode/fuzz acceptance:

1. Production six-byte MAGIC and normative integer/CRC byte order.
2. Exact 18,587-byte baseline and SHA-256.
3. Original 304-byte v3.1 wire sample.
4. Exact ACTIONS bytes and canonical JSON rules.
5. State schema and canonical state serialization rules.
6. Frequency/escape-table semantics and complete rANS state representation.
7. Encoder, decoder, seed-999 mutation corpus, and unedited fuzz log.

The reported CRC value `0xccec3394` and reported 500/500 hard-fail fuzz result are recorded as claims awaiting reproduction; they are not asserted by these tests.

## v3.2 security work — not implemented here

CRC-32 detects accidental corruption; it is not authentication. A v3.2 outer AES-256-GCM envelope needs a normative format, 96-bit nonce uniqueness strategy, 128-bit tag, authenticated header/AAD definition, key provisioning/rotation, and fail-closed handling. RAW fallback must be explicitly typed and authenticated under the same envelope. Do not deploy an ad-hoc wrapper or reuse a GCM nonce.

## Related legacy code reviewed

The connected HeavenzFire GitHub repositories contain an older `HighRadixCodec` in `EntangledMultimodalSystem-2`:

- [TypeScript implementation](https://github.com/HeavenzFire/EntangledMultimodalSystem-2/blob/main/src/utils/HighRadixCodec.ts)
- [JavaScript implementation](https://github.com/HeavenzFire/EntangledMultimodalSystem-2/blob/main/neural-mesh-registry/src/utils/HighRadixCodec.js)

That code is a Base85/Base94 text representation layer with optional DEFLATE in the JavaScript version; it is not the reported HFWBC1 state-prediction/rANS format. Its own JavaScript source explicitly describes the radix transform as encoding rather than compression. It also uses a bigint conversion without an unambiguous original byte-length contract in the TypeScript path, so it must not be treated as a lossless reference decoder for arbitrary binary fixtures. It was reviewed but not imported or modified.
## v3.2 authenticated outer envelope — draft implementation

The separate `hfwbc1-v3_2-envelope.cjs` module implements a provisional authenticated wrapper using Node's built-in AES-256-GCM:

| Field | Width |
|---|---:|
| Magic (`HFWG`) | 4 bytes |
| Envelope format version | 1 byte |
| Payload mode (`RAW=0`, `HFWBC1=1`) | 1 byte |
| GCM nonce | 12 bytes |
| Ciphertext length (big-endian) | 4 bytes |
| Ciphertext | declared length |
| GCM tag | 16 bytes |

The exact 22-byte header plus caller-supplied context bytes are authenticated as GCM AAD. The parser rejects truncated records, trailing bytes, unknown modes, and over-limit ciphertexts. Decryption returns no plaintext unless GCM authentication succeeds.

RAW fallback selects HFWBC1 payload bytes only when they are strictly smaller than the raw bytes; equal or larger candidates use RAW. The wrapper does not implement the HFWBC1 codec and does not claim compatibility with a production v3.2 wire standard.

**Nonce rule:** the caller must supply a unique 96-bit nonce for every encryption under a given key. This module intentionally does not invent an in-memory nonce counter or claim durable nonce allocation. Production integration must bind key selection, key rotation, and a durable per-key nonce-allocation strategy to the caller's key-management layer. The context bytes must bind the ciphertext to its intended protocol/channel/record context.

The v3.2 wrapper is draft code pending protocol review, durable nonce allocation, key-management integration, independent implementation review, and end-to-end tests with the recovered production v3.1 payload.
