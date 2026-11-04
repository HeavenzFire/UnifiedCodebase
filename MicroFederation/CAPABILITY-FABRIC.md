# Unified Field Capability Fabric

## Purpose

The Capability Fabric is a host-controlled registry, dependency resolver, lifecycle manager, and opt-in Google API JavaScript Client (GAPI) compatibility bridge. It is an original adapter layer; it does not replace Google's authentication, API services, or hosted loader.

## Contracts

- Capability identifiers are stable, bounded identifiers; versions use numeric major.minor.patch.
- Dependencies are resolved in topological order. Missing dependencies and cycles fail closed.
- Adapters are supplied by the trusted host process. Registry data cannot name a filesystem path, JavaScript expression, executable, or arbitrary script URL.
- Optional origins must be bare HTTPS origins and explicitly allowlisted.
- Activation is idempotent for capabilities already in the ready state.
- If activation fails, newly activated dependencies are disposed in reverse order when their adapter exposes a dispose function.
- The GAPI compatibility override is opt-in. It intercepts only names prefixed with hf.; all other GAPI module names are delegated to the original gapi.load.
- Uninstall restores the original method only if no other integration has replaced the wrapper in the meantime.

## Security boundary

This layer does not evaluate code, inject scripts, obtain credentials, alter OAuth configuration, or transmit telemetry. The optional GAPI method override is a compatibility hook, not a security sandbox. Google-owned features remain under Google's loader and security policy. High-impact adapters still require a separate approval mechanism before they are made available to a host.

## Command Center API

When a CapabilityFabric instance is injected into createCommandCenterServer({ capabilityFabric }):

- GET /api/capabilities returns registered capability metadata and current lifecycle states.
- POST /api/capabilities/plan accepts a JSON object with a capabilities array and returns dependency order and adapter availability without activating anything.

Both routes inherit the Command Center's loopback Host/Origin checks. The registry is in-memory in this initial release; persist definitions and lifecycle events through a reviewed host adapter before treating it as a durable source of truth.

## Test

Run: node --test MicroFederation/test-capability-fabric.cjs
