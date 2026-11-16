#!/usr/bin/env node
"use strict";

// The VS Code Marketplace rejects semver prerelease tags, so the preview
// channel publishes the patch after the version semantic-release just tagged
// (v1.12.0 -> 1.12.1). Stable promotion then publishes 1.12.0 as a regular
// version, which the Marketplace allows even though the preview is higher:
// that is what keeps preview users on the preview channel.
const STABLE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function previewVersion(stableVersion) {
  const match = STABLE_VERSION.exec(String(stableVersion ?? "").trim());
  if (!match) {
    throw new Error(`Expected a stable version like v1.12.0 or 1.12.0, received "${stableVersion}".`);
  }

  const [, major, minor, patch] = match.map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

if (require.main === module) {
  try {
    process.stdout.write(`${previewVersion(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { previewVersion };
