# Dependency audit policy

CI runs `npm audit --json --package-lock-only` against `package-lock.json` and publishes two artifacts:

- `summary.md` is the readable list of vulnerable packages, severity, direct/transitive status, installed dependency paths, advisory links, and available fixes.
- `audit.json` is the complete machine-readable npm audit response.

The audit includes production and development dependencies. It does not update dependencies or fail the workflow for reported advisories. A failure to run the audit or parse its response remains a CI error so a missing report is not presented as a clean audit.

## Baseline triage

Review the artifact on each CI run. For each advisory, confirm whether the affected package is used in the extension's runtime or only in development tooling, inspect the listed dependency path and advisory, then assign an owner and remediation issue or document a reasoned exception with an expiry/review date. Prefer updating the narrowest responsible direct dependency and verify the resulting lockfile with the project checks.

Do not introduce a blocking audit threshold until the existing baseline has been triaged, remediation or time-bounded exceptions are tracked, and maintainers have agreed on severity and dependency scope. Re-evaluate the gate after that work; do not treat the current non-blocking report as permanent acceptance of new advisories.
