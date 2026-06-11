# Security Policy

## Supported Versions

Only the latest published release of `@kynetic-ai/spec` receives security fixes. Please upgrade to the latest version before reporting.

## Reporting a Vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/lepahc/kynetic-spec/security/advisories/new) on the `lepahc/kynetic-spec` repository. Do not open a public issue for security problems.

You can expect an acknowledgement within 7 days. Triage and fix timelines depend on severity, and we will keep you updated through the advisory.

## Scope

The kspec daemon (`kspec serve`) binds a local HTTP API (default port 3456) and serves the web UI. Reports about network-reachable surfaces — the daemon API, the web UI, and anything exposed if the daemon is reachable beyond localhost — are explicitly in scope, alongside the CLI and published package contents.
