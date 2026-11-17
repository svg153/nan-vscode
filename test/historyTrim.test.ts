import assert from "node:assert/strict";
import test from "node:test";
import {
  groupHistoryUnits,
  historyConversationKey,
  trimHistoryToBudget,
} from "../src/openai/historyTrim";
import { countOpenAIMessagesTokens } from "../src/openai/tokens";
import type { OpenAIMessage } from "../src/openai/types";

const user = (text: string): OpenAIMessage => ({ role: "user", content: text });
const assistant = (text: string): OpenAIMessage => ({ role: "assistant", content: text });
const system = (text: string): OpenAIMessage => ({ role: "system", content: text });
const call = (id: string, name = "lookup", input: unknown = {}): OpenAIMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }],
});
const result = (id: string, content = "ok"): OpenAIMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});

function assertNoOrphanToolResults(messages: readonly OpenAIMessage[]): void {
  const declared = new Set<string>();
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      declared.add(toolCall.id);
    }
    if (message.role === "tool") {
      assert.ok(
        message.tool_call_id !== undefined && declared.has(message.tool_call_id),
        `tool result ${message.tool_call_id} has no matching tool call`,
      );
    }
  }
}

test("keeps an assistant tool call and all of its results in one atomic unit", () => {
  const messages = [user("hi"), call("call-1"), result("call-1"), result("call-1", "second"), assistant("done")];
  const units = groupHistoryUnits(messages);

  assert.equal(units.length, 3);
  assert.deepEqual(
    units[1].messages.map((message) => message.role),
    ["assistant", "tool", "tool"],
  );
});

test("joins a separated tool result to the call that declared it, never across units", () => {
  const callMessage = call("call-1");
  const resultMessage = result("call-1");
  const units = groupHistoryUnits([user("hi"), callMessage, assistant("narration"), resultMessage, user("next")]);
  const owners = units.filter((unit) => unit.messages.includes(callMessage) || unit.messages.includes(resultMessage));

  assert.equal(owners.length, 1);
  assert.ok(owners[0].messages.includes(callMessage));
  assert.ok(owners[0].messages.includes(resultMessage));
});

test("returns the identical payload when the history already fits", () => {
  const messages = [user("hello"), call("call-1"), result("call-1"), assistant("done")];
  const tokens = countOpenAIMessagesTokens(messages);
  const trimmed = trimHistoryToBudget(messages, tokens);

  assert.equal(trimmed.messages, messages);
  assert.equal(trimmed.trimmed, false);
  assert.equal(trimmed.discardedUnits, 0);
  assert.equal(trimmed.tokensBefore, tokens);
  assert.equal(trimmed.tokensAfter, tokens);
  assert.equal(JSON.stringify(trimmed.messages), JSON.stringify(messages));
});

test("discards units from the middle outward", () => {
  const messages = [
    user("u1-pad00"),
    assistant("a1-pad00"),
    user("u2-pad00"),
    assistant("a2-pad00"),
    user("u3-pad00"),
    assistant("a3-pad00"),
    user("u4-pad00"),
  ];
  // Every message is eight characters, so every unit costs two tokens.
  assert.equal(countOpenAIMessagesTokens(messages), 14);

  const trimmed = trimHistoryToBudget(messages, 10);
  const texts = trimmed.messages.map((message) => message.content);

  assert.equal(trimmed.discardedUnits, 2);
  // Middle first, then the unit before it; the outer units survive.
  assert.deepEqual(texts, ["u1-pad00", "a1-pad00", "u3-pad00", "a3-pad00", "u4-pad00"]);
  assert.equal(trimmed.tokensAfter, 10);
  assert.equal(trimmed.fits, true);
});

test("trims exactly at the budget boundary and not one token earlier", () => {
  const messages = [user("u1-pad00"), user("u2-pad00"), user("u3-pad00"), user("u4-pad00")];

  assert.equal(trimHistoryToBudget(messages, 8).trimmed, false);
  const overBudget = trimHistoryToBudget(messages, 7);
  assert.equal(overBudget.trimmed, true);
  assert.equal(overBudget.tokensAfter, 6);
});

test("preserves system framing, the first unit and the current turn", () => {
  const messages = [
    system("frame"),
    user("first"),
    assistant("old-a1"),
    user("old-u2"),
    assistant("old-a2"),
    user("current"),
  ];

  const trimmed = trimHistoryToBudget(messages, 1);

  assert.deepEqual(
    trimmed.messages.map((message) => message.content),
    ["frame", "first", "current"],
  );
  assert.equal(trimmed.discardedUnits, 3);
  // Even the protected units cannot fit in a one-token budget: say so instead
  // of pretending the payload was reduced enough.
  assert.equal(trimmed.fits, false);
});

test("never leaves an orphan tool result when trimming", () => {
  const messages = [user("u0"), call("call-1", "lookup", {}), assistant("n"), result("call-1"), user("now")];
  const trimmed = trimHistoryToBudget(messages, 3);

  assert.ok(trimmed.trimmed);
  assertNoOrphanToolResults(trimmed.messages);
  assert.equal(
    trimmed.messages.some((message) => message.role === "tool"),
    trimmed.messages.some((message) => (message.tool_calls ?? []).length > 0),
  );
});

test("keeps the current tool-call unit intact even when it is the only protected unit", () => {
  const messages = [user("u0"), user("u1"), call("call-9"), result("call-9"), assistant("u2"), call("call-10"), result("call-10")];
  const trimmed = trimHistoryToBudget(messages, 1);

  assert.ok(trimmed.messages.includes(messages[5]));
  assert.ok(trimmed.messages.includes(messages[6]));
  assertNoOrphanToolResults(trimmed.messages);
});

test("allows a normal no-op when the budget is unknown", () => {
  const messages = [user("hello"), assistant("world")];
  const trimmed = trimHistoryToBudget(messages, Number.POSITIVE_INFINITY);

  assert.equal(trimmed.messages, messages);
  assert.equal(trimmed.trimmed, false);
});

test("derives a stable conversation key without exposing content", () => {
  const first = [user("same question"), assistant("one"), user("follow-up")];
  const differentTail = [user("same question"), assistant("other"), user("different follow-up")];
  const otherConversation = [user("another question"), assistant("one")];

  assert.equal(historyConversationKey(first), historyConversationKey(differentTail));
  assert.notEqual(historyConversationKey(first), historyConversationKey(otherConversation));
  assert.match(historyConversationKey(first), /^[0-9a-f]{8}$/);
});
