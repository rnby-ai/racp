# Changelog

All notable changes to the public RACP packages are documented here.

## 0.1.0 - 2026-08-06

Initial public release.

- Added the strict RACP v1 binary codec, full SHA-256 validation, intent
  registry, and language-neutral golden vectors.
- Added the event-driven adapter-based client with durable message drain,
  acknowledgement semantics, capability discovery/routing, protocol tasks,
  and causal task events.
- Added the OAuth-backed hosted RnBy MCP/Realtime agent adapter and offline
  interoperability CLI.
- Added the typed bridge lifecycle boundary, including explicit fail-closed
  behavior when no embedding driver is configured.
- Added TypeScript local/hosted examples, Codex and Claude MCP configuration,
  and a Python standard-library golden-vector agent.
