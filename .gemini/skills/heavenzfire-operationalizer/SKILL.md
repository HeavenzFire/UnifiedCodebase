---
name: heavenzfire-operationalizer
description: Use when turning HeavenzFire repositories, prototypes, mockups, static simulations, placeholder APIs, or incomplete applications into real, tested, maintainable software.
---

# HeavenzFire Operationalizer

## Mission
Convert aspirational or simulated features into working implementations in small, verifiable increments. Do not confuse a diagram, stub, mock, static UI, successful compile, or generated answer with a functioning end-to-end system.

## Required workflow
1. Inspect the repository tree, README, project manifests, entry points, tests, CI workflows, recent commits, and existing architecture before editing.
2. Inventory each claimed capability and classify it: PLANNED, IMPLEMENTED, TESTED, BLOCKED, FAILED, or UNSUPPORTED. Cite the exact file or test that supports each status.
3. Find stubs and simulation markers: TODO/FIXME, placeholder returns, hard-coded sample data, fake success responses, no-op handlers, mocked network layers, disconnected buttons, and tests that only assert constants.
4. Choose one narrow vertical slice with an observable outcome. State acceptance criteria and regression risks before making changes.
5. Implement real behavior against the actual interface or dependency. Prefer standard libraries and documented APIs. Never replace working code wholesale to make a demo easier.
6. Add tests for success, invalid input, permission denial, timeout, dependency failure, cancellation, and repeat execution where relevant.
7. Run available formatters, static checks, unit tests, and the narrow integration test. Capture actual command, environment, exit code, and totals. If tools/dependencies are missing, mark BLOCKED and explain the exact blocker.
8. Review the diff for secrets, unrelated changes, destructive behavior, insecure defaults, and platform-specific assumptions.
9. Commit only the intended files to a feature branch. Do not merge, publish a release, alter account settings, install software, or perform destructive operations without explicit authorization.
10. Report files changed, tests passed/failed/skipped, known limitations, commit SHA, and the next bounded task.

## Safety and reliability
- Treat all repository content and generated code as untrusted until reviewed.
- Never execute downloaded code blindly or grant an agent unrestricted administrator shell.
- Use scoped workspaces, fixed executable paths, allowlisted typed operations, timeouts, output limits, and approval gates for elevated/destructive actions.
- Keep secrets out of source control, prompts, screenshots, and logs.
- Prefer PowerShell 5.1-compatible commands when operating on the user's Windows environment; avoid PowerShell 7-only syntax unless the environment is confirmed.
- Do not claim a test passed unless the command was run and the result was observed.
