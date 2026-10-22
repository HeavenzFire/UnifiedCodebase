# Security Notes

This MVP routes chat requests to a loopback Ollama service only. It does not execute tools, read arbitrary files, or accept cloud API keys.

## Do not expose it to a network
There is no authentication or TLS. Keep the listener on 127.0.0.1. Localhost binding does not protect against malicious processes already running as the same user.

## Not yet audited
No formal security review has been completed. Report suspected vulnerabilities privately to the repository maintainers where possible; avoid posting exploit details for an unpatched issue.

## Before adding tools
Each capability needs an explicit scope, separate policy checks, approval gates for write/admin/destructive actions, and tests proving denied actions remain denied. Do not treat an LLM prompt as a security boundary.
