const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,})\b/gi;

export function sanitizeUpstreamText(text: string, maxLength: number): string {
  const withoutControls = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("");
  return withoutControls.replace(SECRET_PATTERN, "******").replace(/ {2,}/g, " ").trim().slice(0, maxLength);
}
