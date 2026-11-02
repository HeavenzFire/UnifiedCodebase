# HeavenzFire Native Tool Runtime

**Status:** first implementation; code-defined tools only. This module is not wired into a live host or provider by default.

## Purpose

Provide a HeavenzFire-owned contract for registering, describing, authorizing, executing, and recording native tools. Provider integrations are adapters behind tool handlers; they do not define the runtime or authority model.

## Contract

Each tool declares:
- stable lowercase ID and semantic version;
- bounded description;
- required capability;
- restricted JSON input schema;
- code-defined handler;
- cooperative execution timeout.

ToolRegistry rejects duplicate IDs, unsupported definition fields, unsafe/unbounded object schemas, and dynamic handler references in public metadata.

ToolRuntime requires injected authorization and evidence-recording functions. Before invoking a handler it validates the input, checks the capability grant, and persists a start event. It records success/failure with tool version, principal, task, capability, timestamps, and SHA-256 digests of input/output. Raw inputs and outputs are not copied into evidence events.

## Security boundaries

- No eval, Function, dynamic imports, shell execution, or automatic code loading.
- No tool runs merely because the module is imported or registered.
- No authorization fallback: missing/denied authorization blocks execution.
- No evidence fallback: failure to persist the start event blocks execution.
- High-impact approval is delegated to the injected authority. In the existing architecture, adapt CapabilityGate.authorize(); do not accept a caller-provided approval boolean.
- Input schemas are a deliberately small JSON-schema subset. Remote $ref, regex patterns, arbitrary schema keywords, and open-ended object properties are not supported.
- Timeouts use AbortController and are cooperative. A handler that ignores its signal may continue running after the caller receives a timeout; use an OS/container sandbox for untrusted or non-cooperative code.
- The runtime does not provide cross-process locking, durable handler execution, retries, or exactly-once side effects.
- Evidence hashes establish content identity, not authenticity or tamper-proof storage. Anchor evidence in the protected host ledger for stronger provenance.
- Tool handlers must enforce their own path, network, resource, and data-sensitivity boundaries.

## Minimal integration

    const { ToolRegistry, ToolRuntime } = require('./native-tool-runtime.cjs');
    const registry = new ToolRegistry();
    registry.register({
      id: 'system.health',
      version: '1.0.0',
      description: 'Return a bounded health summary.',
      capability: 'system.health.read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ status: 'ok' })
    });
    const runtime = new ToolRuntime({
      registry,
      authorize: request => adaptivePlane.authorizeAction(request),
      recordEvidence: event => evidenceLedger.append(event)
    });

The example is an integration pattern, not a claim that adaptivePlane or evidenceLedger is currently wired to a live service.

## Verification

From the repository root:

    node --check Tools/native-tool-runtime.cjs
    node --test Tools/native-tool-runtime.test.cjs

The tests use deterministic injected authorizers and evidence sinks. They prove the module's local contracts, not production identity, host isolation, or live deployment.
