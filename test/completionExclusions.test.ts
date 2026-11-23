import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_COMPLETION_EXCLUDED_GLOBS,
  DEFAULT_COMPLETION_EXCLUDED_LANGUAGES,
  globToRegExp,
  isCompletionExcluded,
  matchesExcludedGlob,
  matchesExcludedLanguage,
} from "../src/completionExclusions";

test("defaults cover plain text, dotenv, key material, and secrets folders", () => {
  assert.deepEqual([...DEFAULT_COMPLETION_EXCLUDED_LANGUAGES], ["plaintext", "dotenv", "properties"]);
  assert.deepEqual(
    [...DEFAULT_COMPLETION_EXCLUDED_GLOBS],
    ["**/.env*", "**/*.pem", "**/*.key", "**/secrets/**"],
  );
});

test("package.json exposes the same defaults as the helper", () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as {
    contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
  };
  const properties = manifest.contributes?.configuration?.properties ?? {};
  assert.deepEqual(
    properties["nanBuilders.completionExcludedLanguages"]?.default,
    [...DEFAULT_COMPLETION_EXCLUDED_LANGUAGES],
  );
  assert.deepEqual(
    properties["nanBuilders.completionExcludedGlobs"]?.default,
    [...DEFAULT_COMPLETION_EXCLUDED_GLOBS],
  );
});

test("language matching is exact, case-insensitive, and ignores surrounding whitespace", () => {
  assert.equal(matchesExcludedLanguage("plaintext", DEFAULT_COMPLETION_EXCLUDED_LANGUAGES), true);
  assert.equal(matchesExcludedLanguage("dotenv", DEFAULT_COMPLETION_EXCLUDED_LANGUAGES), true);
  assert.equal(matchesExcludedLanguage(" DotEnv ", DEFAULT_COMPLETION_EXCLUDED_LANGUAGES), true);
  assert.equal(matchesExcludedLanguage("typescript", DEFAULT_COMPLETION_EXCLUDED_LANGUAGES), false);
  assert.equal(matchesExcludedLanguage("plaintext", []), false);
  assert.equal(matchesExcludedLanguage("", DEFAULT_COMPLETION_EXCLUDED_LANGUAGES), false);
});

test("default globs match dotenv, key files, and secrets anywhere in a tree", () => {
  const globs = DEFAULT_COMPLETION_EXCLUDED_GLOBS;
  for (const filePath of [
    ".env",
    ".env.local",
    "/home/me/project/.env.production",
    "/home/me/project/certs/server.pem",
    "/home/me/project/id_ed25519.key",
    "/home/me/project/secrets/token.txt",
    "/home/me/project/secrets/nested/token.txt",
  ]) {
    assert.equal(matchesExcludedGlob(filePath, globs), true, filePath);
  }
});

test("Windows-style paths match the default globs", () => {
  const globs = DEFAULT_COMPLETION_EXCLUDED_GLOBS;
  for (const filePath of [
    "C:\\Users\\me\\project\\.env",
    "C:\\Users\\me\\project\\.env.local",
    "C:\\Users\\me\\project\\certs\\server.pem",
    "C:\\Users\\me\\project\\keys\\private.key",
    "C:\\Users\\me\\project\\secrets\\token.txt",
  ]) {
    assert.equal(matchesExcludedGlob(filePath, globs), true, filePath);
  }
});

test("similar-looking paths are not excluded by the default globs", () => {
  const globs = DEFAULT_COMPLETION_EXCLUDED_GLOBS;
  for (const filePath of [
    "/home/me/project/src/env.ts",
    "/home/me/project/src/secrets.ts",
    "/home/me/project/src/server.pem.txt",
    "/home/me/project/src/private.keyboard",
    "/home/me/project/src/notasecret/file.ts",
    "",
  ]) {
    assert.equal(matchesExcludedGlob(filePath, globs), false, filePath);
  }
});

test("a custom glob that does not match leaves the document enabled", () => {
  assert.equal(matchesExcludedGlob("/home/me/project/src/app.ts", ["**/*.md", "docs/**"]), false);
  assert.equal(matchesExcludedGlob("/home/me/project/src/app.ts", []), false);
});

test("single-star and question-mark globs stay within one path segment", () => {
  assert.equal(matchesExcludedGlob("/repo/src/app.ts", ["*.ts"]), true);
  assert.equal(matchesExcludedGlob("/repo/src/app.ts", ["src/*.ts"]), true);
  assert.equal(matchesExcludedGlob("/repo/src/deep/app.ts", ["src/*.ts"]), false);
  assert.equal(matchesExcludedGlob("/repo/src/deep/app.ts", ["**/deep/*.ts"]), true);
  assert.equal(matchesExcludedGlob("/repo/src/app1.ts", ["**/app?.ts"]), true);
  assert.equal(matchesExcludedGlob("/repo/src/app12.ts", ["**/app?.ts"]), false);
});

test("glob compilation escapes regular-expression metacharacters", () => {
  assert.equal(globToRegExp("**/a+b.ts").test("/repo/src/a+b.ts"), true);
  assert.equal(globToRegExp("**/a+b.ts").test("/repo/src/aab.ts"), false);
  assert.equal(globToRegExp("**/(generated)/**").test("/repo/(generated)/x.ts"), true);
});

test("malformed settings fall back to defaults instead of throwing", () => {
  assert.equal(
    isCompletionExcluded({
      languageId: "plaintext",
      filePath: "/repo/src/app.ts",
      excludedLanguages: "plaintext" as unknown as string[],
      excludedGlobs: [42] as unknown as string[],
    }),
    true,
  );
  assert.equal(
    matchesExcludedGlob("/repo/src/app.ts", [null, undefined, 7] as unknown as string[]),
    false,
  );
});

test("isCompletionExcluded combines language and glob settings", () => {
  const base = { languageId: "typescript", filePath: "/repo/src/app.ts" };
  assert.equal(isCompletionExcluded(base), false);
  assert.equal(isCompletionExcluded({ ...base, languageId: "plaintext" }), true);
  assert.equal(
    isCompletionExcluded({ ...base, filePath: "C:\\repo\\secrets\\token.txt" }),
    true,
  );
  assert.equal(
    isCompletionExcluded({
      ...base,
      languageId: "plaintext",
      excludedLanguages: [],
      excludedGlobs: [],
    }),
    false,
  );
  assert.equal(
    isCompletionExcluded({
      ...base,
      excludedLanguages: [" typescript "],
      excludedGlobs: ["**/*.ts"],
    }),
    true,
  );
});
