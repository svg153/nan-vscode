import { countOpenAIMessageTokens } from "./tokens";
import type { OpenAIMessage } from "./types";

/**
 * History trimmer for the OpenAI-compatible request payload.
 *
 * A turn is only valid upstream while every `tool_calls` entry keeps its
 * matching `tool` result, so the unit of trimming is atomic: an assistant
 * message travels with the tool results that reference its call ids and is
 * never split. Units are dropped from the middle outward until the estimated
 * input fits the budget the model advertises, while the first unit, any
 * system framing, and the trailing unit are always preserved.
 */
export interface HistoryUnit {
  /** Messages of this unit, in their original conversation order. */
  readonly messages: readonly OpenAIMessage[];
  readonly tokens: number;
}

export interface HistoryTrimResult {
  /**
   * Messages to send. When nothing was dropped this is the exact array that
   * was passed in, so a conversation that already fits is byte-identical.
   */
  readonly messages: readonly OpenAIMessage[];
  readonly unitCount: number;
  readonly discardedUnits: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when at least one unit was discarded. */
  readonly trimmed: boolean;
  /** False when the protected units alone still exceed the budget. */
  readonly fits: boolean;
}

/**
 * Groups a converted conversation into atomic units. A `tool` message joins
 * the unit of the assistant message that declared its `tool_call_id`, even
 * when an unrelated message was converted in between, so a kept unit can
 * never reference a dropped call or leave an orphan result behind.
 */
export function groupHistoryUnits(messages: readonly OpenAIMessage[]): HistoryUnit[] {
  const units: OpenAIMessage[][] = [];
  const positions = new Map<OpenAIMessage, number>();
  const callOwners = new Map<string, number>();

  messages.forEach((message, index) => {
    positions.set(message, index);
    if (message.role === "tool") {
      const owner = message.tool_call_id ? callOwners.get(message.tool_call_id) : undefined;
      if (owner !== undefined) {
        units[owner].push(message);
        return;
      }
      const last = units.length - 1;
      if (last >= 0) {
        units[last].push(message);
        return;
      }
      units.push([message]);
      return;
    }
    units.push([message]);
    for (const call of message.tool_calls ?? []) {
      callOwners.set(call.id, units.length - 1);
    }
  });

  return units.map((unit) => {
    const ordered = unit
      .slice()
      .sort((left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));
    return {
      messages: ordered,
      tokens: ordered.reduce((sum, message) => sum + countOpenAIMessageTokens(message), 0),
    };
  });
}

/**
 * Drops whole units from the middle of the history until the estimated payload
 * fits `budgetTokens`. The first unit, system framing, and the trailing unit
 * are preserved; if those alone exceed the budget the result reports
 * `fits: false` and still returns every message it had to keep.
 */
export function trimHistoryToBudget(
  messages: readonly OpenAIMessage[],
  budgetTokens: number,
): HistoryTrimResult {
  const units = groupHistoryUnits(messages);
  const unitCount = units.length;
  const tokensBefore = units.reduce((sum, unit) => sum + unit.tokens, 0);
  const budget = Number.isFinite(budgetTokens)
    ? Math.max(1, Math.floor(budgetTokens))
    : Number.POSITIVE_INFINITY;

  if (tokensBefore <= budget || unitCount === 0) {
    return { messages, unitCount, discardedUnits: 0, tokensBefore, tokensAfter: tokensBefore, trimmed: false, fits: true };
  }

  const protectedUnits = protectedUnitIndices(units);
  const candidates: number[] = [];
  for (let index = 0; index < unitCount; index += 1) {
    if (!protectedUnits.has(index)) {
      candidates.push(index);
    }
  }
  if (candidates.length === 0) {
    return { messages, unitCount, discardedUnits: 0, tokensBefore, tokensAfter: tokensBefore, trimmed: false, fits: false };
  }

  const discarded = new Set<number>();
  const remaining = candidates.slice();
  let tokensAfter = tokensBefore;
  while (tokensAfter > budget && remaining.length > 0) {
    const middle = Math.floor((remaining.length - 1) / 2);
    const [index] = remaining.splice(middle, 1);
    discarded.add(index);
    tokensAfter -= units[index].tokens;
  }

  const kept = new Set<OpenAIMessage>();
  units.forEach((unit, index) => {
    if (!discarded.has(index)) {
      for (const message of unit.messages) {
        kept.add(message);
      }
    }
  });

  return {
    messages: messages.filter((message) => kept.has(message)),
    unitCount,
    discardedUnits: discarded.size,
    tokensBefore,
    tokensAfter,
    trimmed: discarded.size > 0,
    fits: tokensAfter <= budget,
  };
}

/**
 * Stable, content-derived key for the conversation a history belongs to, used
 * to warn at most once per conversation. Only a hash is retained in memory;
 * message content is never persisted or logged.
 */
export function historyConversationKey(messages: readonly OpenAIMessage[]): string {
  const firstUnit = groupHistoryUnits(messages)[0];
  let hash = 0x811c9dc5;
  let length = 0;
  for (const message of firstUnit?.messages ?? []) {
    const text = `${message.role}\u0000${messageText(message)}\u0000${(message.tool_calls ?? [])
      .map((call) => `${call.id}:${call.function.name}`)
      .join(",")}`;
    for (let index = 0; index < text.length && length < 4096; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
      length += 1;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function protectedUnitIndices(units: readonly HistoryUnit[]): Set<number> {
  const protectedUnits = new Set<number>();
  if (units.length === 0) {
    return protectedUnits;
  }

  // System framing is framing: it is never a trim candidate, wherever it sits.
  units.forEach((unit, index) => {
    if (unit.messages.some((message) => message.role === "system")) {
      protectedUnits.add(index);
    }
  });

  // Never drop the opening of the conversation, including the first user turn
  // that follows leading system framing.
  protectedUnits.add(0);
  const firstConversationUnit = units.findIndex((unit) =>
    unit.messages.every((message) => message.role !== "system"),
  );
  if (firstConversationUnit >= 0) {
    protectedUnits.add(firstConversationUnit);
  }

  // The trailing unit is the request being answered right now, together with
  // its tool calls and results; trimming it would make the turn unanswerable.
  protectedUnits.add(units.length - 1);
  return protectedUnits;
}

function messageText(message: OpenAIMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => (part.type === "text" ? part.text : "image")).join("");
}
