# Dependency audit policy

CI runs `npm audit --json --package-lock-only` against `package-lock.json` and publishes two artifacts:

- `summary.md` is the readable list of vulnerable packages, severity, direct/transitive status, installed dependency paths, advisory links, and available fixes.
- `audit.json` is the complete machine-readable npm audit response.

The audit includes production and development dependencies. It does not update dependencies or fail the workflow for reported advisories. A failure to run the audit or parse its response remains a CI error so a missing report is not presented as a clean audit.

## Baseline triage

Review the artifact on each CI run. For each advisory, confirm whether the affected package is used in the extension's runtime or only in development tooling, inspect the listed dependency path and advisory, then assign an owner and remediation issue or document a reasoned exception with an expiry/review date. Prefer updating the narrowest responsible direct dependency and verify the resulting lockfile with the project checks.

Do not introduce a blocking audit threshold until the existing baseline has been triaged, remediation or time-bounded exceptions are tracked, and maintainers have agreed on severity and dependency scope. Re-evaluate the gate after that work; do not treat the current non-blocking report as permanent acceptance of new advisories.

## Critical and high baseline triage (2026-11-02)

The current lockfile audit reports one critical and four high vulnerable package groups. All five are development-tool dependencies; the root package has no production dependencies, and the extension package command uses `vsce package --no-dependencies`. They are not shipped in the VSIX runtime, but remain reachable during CI, packaging, and release automation.

| Package | Severity | Locked path and version | Runtime reachability | Remediation or exception |
|---|---|---|---|---|
| `@azure/identity` | High | `@vscode/vsce@4.0.0` → `@azure/identity@4.13.3` → `@azure/msal-node@6.0.1` | Development packaging only | `@azure/identity@4.14.1` depends on `@azure/msal-node ^7.1.0`; defer this lockfile update because fetching package tarballs is blocked in this environment. |
| `@azure/msal-node` | High | `@vscode/vsce@4.0.0` → `@azure/identity@4.13.3` → `@azure/msal-node@6.0.1` | Development packaging only | Update to `>=7.1.0` through a compatible `@azure/identity` release; defer for the same package-fetch restriction. Advisory: [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5). |
| `brace-expansion` | High | `@semantic-release/npm@13.2.0` → `npm@11.20.0` → `brace-expansion@5.0.9` | Release tooling only | Update the nested copy to `>=5.0.12`; defer because the required npm package update cannot be fetched here. |
| `handlebars` | Critical | `semantic-release@25.0.9` → `@semantic-release/commit-analyzer@13.0.1` → `conventional-changelog-writer@8.4.0` → `handlebars@4.7.9` | Release tooling only | Update to `4.7.10` or later; defer the lockfile update because package tarball fetching is blocked. |
| `undici` | High | `@actions/http-client@4.0.1` → `undici@6.28.1`; nested npm copy `6.28.0`; root copy `7.29.1` | Release tooling only | Update v6 copies to `>=6.29.1` and v7 copies to `>=7.30.1`; defer the lockfile update because package tarball fetching is blocked. |

**Disposition and owner:** These are time-bounded exceptions, not accepted permanent risk. Repository build/release maintainers own updating the compatible toolchain and regenerating the lockfile; review the exceptions by **2026-12-02**. The report lists fixes as available, but `npm audit fix --dry-run --package-lock-only` was blocked with `EALLOWREMOTE` while trying to fetch `npm-11.21.1.tgz`, so no dependency or lockfile changes were made. The production-only audit (`npm audit --omit=dev`) reported zero advisories.
