/**
 * Pure language and path matching for inline-completion exclusions.
 *
 * Kept free of `vscode` imports so the inline completion provider can decide
 * whether a document is excluded without sending a request, and unit tests can
 * cover the matching rules without a VS Code host. Globs are matched by a small
 * built-in implementation (no runtime dependency) that understands `**`, `*`,
 * and `?` and treats both `/` and `\` as separators.
 */

/** Languages skipped by default: free text, dotenv, and properties files. */
export const DEFAULT_COMPLETION_EXCLUDED_LANGUAGES: readonly string[] = [
  "plaintext",
  "dotenv",
  "properties",
];

/** File patterns skipped by default: dotenv, key material, and secrets folders. */
export const DEFAULT_COMPLETION_EXCLUDED_GLOBS: readonly string[] = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/secrets/**",
];

export interface CompletionExclusionOptions {
  /** VS Code language id of the document. */
  languageId: string;
  /** Document path; Windows backslashes and absolute prefixes are accepted. */
  filePath: string;
  /** Configured language ids; `undefined` applies the defaults. */
  excludedLanguages?: readonly string[];
  /** Configured globs; `undefined` applies the defaults. */
  excludedGlobs?: readonly string[];
}

/**
 * Whether inline completion must be skipped for this document. Matching is
 * case-insensitive so a setting's casing never changes the outcome on Windows.
 */
export function isCompletionExcluded(options: CompletionExclusionOptions): boolean {
  const languages = readStringList(options.excludedLanguages) ?? DEFAULT_COMPLETION_EXCLUDED_LANGUAGES;
  if (matchesExcludedLanguage(options.languageId, languages)) {
    return true;
  }
  const globs = readStringList(options.excludedGlobs) ?? DEFAULT_COMPLETION_EXCLUDED_GLOBS;
  return matchesExcludedGlob(options.filePath, globs);
}

/** Exact language-id match, ignoring surrounding whitespace and case. */
export function matchesExcludedLanguage(
  languageId: string,
  excludedLanguages: readonly string[],
): boolean {
  const target = normalizeSetting(languageId).toLowerCase();
  if (!target) {
    return false;
  }
  return (readStringList(excludedLanguages) ?? []).some(
    (candidate) => normalizeSetting(candidate).toLowerCase() === target,
  );
}

/** Whether any configured glob matches the file path. */
export function matchesExcludedGlob(filePath: string, excludedGlobs: readonly string[]): boolean {
  const normalizedPath = normalizePath(filePath);
  if (!normalizedPath) {
    return false;
  }
  return (readStringList(excludedGlobs) ?? []).some((glob) => {
    const pattern = normalizeSetting(glob);
    return pattern ? globToRegExp(pattern).test(normalizedPath) : false;
  });
}

/**
 * Compile one glob into an anchored, case-insensitive regular expression.
 *
 * Supported syntax: `**` spans path segments, `*` and `?` stay within one
 * segment, and both slash styles are accepted. A pattern without a leading
 * `**` may match at any depth (`*.pem` matches `src/a.pem`), mirroring how VS
 * Code file globs behave.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeSetting(glob).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  let source = "^(?:.*/)?";
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        let next = index + 2;
        while (normalized[next] === "*") {
          next += 1;
        }
        if (normalized[next] === "/") {
          // `**/` matches zero or more whole segments.
          source += "(?:[^/]+/)*";
          index = next + 1;
        } else {
          source += ".*";
          index = next;
        }
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += escapeRegExp(char);
    index += 1;
  }
  return new RegExp(`${source}$`, "i");
}

const REGEX_SPECIALS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function escapeRegExp(char: string): string {
  return REGEX_SPECIALS.has(char) ? `\\${char}` : char;
}

function normalizeSetting(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Settings are typed, but a hand-edited value must never break completion. */
function readStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizePath(filePath: string): string {
  return normalizeSetting(filePath).replace(/\\/g, "/");
}
