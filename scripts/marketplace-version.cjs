#!/usr/bin/env node
"use strict";

// The VS Code Marketplace rejects semver prerelease tags and requires
// pre-release and regular versions to be distinct, so the preview channel
// publishes in its own patch lane: v1.12.0 -> 1.12.1000, v1.12.1 -> 1.12.1001.
//
// "Tag + 1 patch" is not safe: the preview of v1.12.0 (1.12.1) and the stable
// build of the next fix release, v1.12.1, would be the same number, and
// vsce --skip-duplicate compares version and target (not channel), so the
// validated stable build would be skipped as a duplicate. The offset keeps the
// two lanes disjoint while staying monotonic (1.12.1001 < 1.13.1000), which has
// the same shape as the Marketplace's own even/odd-minor recommendation.
const PREVIEW_PATCH_OFFSET = 1000;
const STABLE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function previewVersion(stableVersion) {
  const match = STABLE_VERSION.exec(String(stableVersion ?? "").trim());
  if (!match) {
    throw new Error(`Expected a stable version like v1.12.0 or 1.12.0, received "${stableVersion}".`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (patch >= PREVIEW_PATCH_OFFSET) {
    throw new Error(
      `Patch ${patch} of "${stableVersion}" reaches the preview patch offset (${PREVIEW_PATCH_OFFSET}), ` +
        "so the preview and stable lanes would overlap; raise PREVIEW_PATCH_OFFSET in scripts/marketplace-version.cjs.",
    );
  }

  return `${major}.${minor}.${patch + PREVIEW_PATCH_OFFSET}`;
}

if (require.main === module) {
  try {
    process.stdout.write(`${previewVersion(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { previewVersion, PREVIEW_PATCH_OFFSET };
