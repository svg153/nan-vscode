# Dependency audit policy

CI runs `npm audit --json --package-lock-only` against `package-lock.json` and publishes two artifacts:

- `summary.md` is the readable list of vulnerable packages, severity, direct/transitive status, installed dependency paths, advisory links, and available fixes.
- `audit.json` is the complete machine-readable npm audit response.

The audit includes production and development dependencies. It does not update dependencies or fail the workflow for reported advisories. A failure to run the audit or parse its response remains a CI error so a missing report is not presented as a clean audit.

Since 2026-11-16 a separate **blocking** gate exists for *new* advisories only: `.github/workflows/dependency-review.yml` fails any PR that introduces a vulnerable package version (GitHub Advisory Database, severity >= moderate). This respects the policy below — the pre-existing baseline described here does not fail PRs.

## Baseline triage

Review the artifact on each CI run. For each advisory, confirm whether the affected package is used in the extension's runtime or only in development tooling, inspect the listed dependency path and advisory, then assign an owner and remediation issue or document a reasoned exception with an expiry/review date. Prefer updating the narrowest responsible direct dependency and verify the resulting lockfile with the project checks.

Do not introduce a blocking audit threshold until the existing baseline has been triaged, remediation or time-bounded exceptions are tracked, and maintainers have agreed on severity and dependency scope. Re-evaluate the gate after that work; do not treat the current non-blocking report as permanent acceptance of new advisories.

## Critical and high baseline triage (2026-11-02)

The current lockfile audit reports one critical and four high vulnerable package groups. All five are development-tool dependencies; the root package has no production dependencies, and the extension package command uses `vsce package --no-dependencies`. They are not shipped in the VSIX runtime, but remain reachable during CI, packaging, and release automation.

| Package | Severity | Locked path and version | Runtime reachability | Remediation or exception |
|---|---|---|---|---|
| `@azure/identity` | High | `@vscode/vsce@4.0.0` → `@azure/identity@4.13.3` → `@azure/msal-node@6.0.1` | Development packaging only | `@azure/identity@4.14.1` depends on `@azure/msal-node ^7.1.0`; defer this lockfile update because fetching package tarballs is blocked in this environment. |
| `@azure/msal-node` | High | `@vscode/vsce@4.0.0` → `@azure/identity@4.13.3` → `@azure/msal-node@6.0.1` | Development packaging only | Update to `>=7.1.0` through a compatible `@azure/identity` release; defer for the same package-fetch restriction. Advisory: [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5). |
| `brace-expansion` | High | `@semantic-release/npm@13.2.0` → `npm@11.21.2` → `brace-expansion@5.0.12` | Release tooling only | **Resolved 2026-11-17 (#146, #153).** The copy is bundled inside the `npm` tarball, so it cannot be patched with a `brace-expansion` override; the `overrides.npm` pin to `^11.21.2` ships `brace-expansion@5.0.12`. |
| `handlebars` | Critical | `semantic-release@25.0.9` → `@semantic-release/commit-analyzer@13.0.1` → `conventional-changelog-writer@8.4.0` → `handlebars@4.7.9` | Release tooling only | Update to `4.7.10` or later; defer the lockfile update because package tarball fetching is blocked. |
| `undici` | High | `@semantic-release/npm@13.2.0` → `npm@11.21.2` → `undici@6.29.1` | Release tooling only | **Resolved 2026-11-17 (#150, #153).** The copy is bundled inside the `npm` tarball, so it cannot be patched with an `undici` override; the `overrides.npm` pin to `^11.21.2` ships `undici@6.29.1`. The `@actions/http-client` copy (`6.29.1`) and the root `undici` (`7.30.1`) were already patched. |

**Disposition and owner:** These are time-bounded exceptions, not accepted permanent risk. Repository build/release maintainers own updating the compatible toolchain and regenerating the lockfile; review the remaining exceptions by **2026-12-02**. The production-only audit (`npm audit --omit=dev`) reported zero advisories.

## Remediation log

| Date | Package | Change | Verification |
|---|---|---|---|
| 2026-11-17 | `brace-expansion` | `overrides.npm` set to `^11.21.2`; lockfile regenerated so the bundled copy moves from `5.0.9` to `5.0.12` (#146, #153) | `npm ls brace-expansion --all` reports `5.0.12` for both instances; `npm audit --package-lock-only` no longer lists `brace-expansion` |
| 2026-11-17 | `undici` | No `undici` override added; the `overrides.npm` pin to `^11.21.2` from #153 ships the patched `6.29.1` inside the npm tarball (#150) | `npm ls undici --all` reports `7.30.1` (root, `@semantic-release/github`), `6.29.1` (`@actions/http-client`) and `6.29.1` (`npm` → `node-gyp`), all outside every advisory range (`<6.29.1`, `>=7.0.0 <7.30.1`, `<6.28.1`, `>=7.0.0 <7.29.1`); `npm audit --package-lock-only` no longer lists `undici` and drops from 48 to 44 advisories |

Packages nested inside a released tarball (`inBundle: true` in `package-lock.json`, as all of npm's own dependencies are) cannot be redirected by an `overrides` entry for that package: the file ships inside the dependency's tarball. Bumping the bundling package is the only lever, so the override is applied to `npm` rather than to `brace-expansion` or `undici`.
