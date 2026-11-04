# HeavenzFire Developer Service MVP

Version 0.1.0. This is a bounded local review MVP; it does not include a cloud control plane or payment processor.

## Product

A licensed developer-assistance service accepts a bounded set of source files and returns a deterministic static-review report. It flags selected patterns: possible hard-coded credentials, dynamic evaluation, process execution calls, and TODO/FIXME markers. It never executes submitted source.

## Hybrid deployment boundary

- Local data plane: run review on the developer workstation. Source is processed in memory; this module makes no outbound network calls.
- Remote control plane (future): licensing administration, customer portal, renewals, and fleet policy may be hosted separately. This MVP verifies a signed license locally.
- Network exposure: loopback only. A future gateway must add TLS, tenant authentication, rate limits, redacted request logs, and explicit customer configuration. Do not expose this listener directly to the internet.

## Requirements

Node.js 18 or newer. No third-party runtime dependencies.

## Host integration

The host must load an Ed25519 public key from protected configuration and supply:
- HF_DEV_API_TOKEN: random bearer token of at least 32 characters.
- HF_DEV_LICENSE_PUBLIC_KEY_FILE: path to PEM-encoded Ed25519 public key.

The issuer private key is not included in this repository. Keep it offline or in a managed signing system.

```js
const fs = require('node:fs');
const { createLicenseVerifier } = require('./license.cjs');
const { createDeveloperService, listenLoopback } = require('./server.cjs');
const publicKey = fs.readFileSync(process.env.HF_DEV_LICENSE_PUBLIC_KEY_FILE, 'utf8');
const server = createDeveloperService({
  licenseVerifier: createLicenseVerifier({ publicKey }),
  apiToken: process.env.HF_DEV_API_TOKEN
});
listenLoopback(server, { port: 18796, host: '127.0.0.1' })
  .then(address => process.stdout.write('LISTENING ' + JSON.stringify(address) + '\\n'));
```

Never place secrets in source files, command-line arguments, repository files, or logs.

## API

- GET /health
- POST /v1/review, with Authorization: Bearer token and JSON containing a signed license envelope plus files: [{ path, content }].

Limits: 50 files, 200 KiB per file, 1 MiB total source, and 1.2 MiB HTTP body. Paths must be relative and traversal-free. Reports contain rule IDs, severity, file path, and line number; matched source snippets are not returned.

## License issuance

The issuer signs canonical JSON payloads with Ed25519. The private key is never stored in this repository. The verifier checks the signature, product ID, exact payload schema, issue/expiry timestamps, and code.review feature. Production issuance, key rotation, revocation, seat enforcement, customer portal, and payment integration remain future work.

## Tests

```sh
node --check DeveloperService/license.cjs
node --check DeveloperService/review-agent.cjs
node --check DeveloperService/server.cjs
node --test DeveloperService/test/developer-service.test.cjs
```

Tests use ephemeral keys and a loopback HTTP server. No customer license or external service is required.

## Limitations

This is not an autonomous code-modifying agent, full SAST engine, dependency vulnerability scanner, or substitute for human review. No repository cloning, shell execution, package installation, code changes, billing, or public network exposure occurs in this MVP.
