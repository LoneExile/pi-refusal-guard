// Behaviour tests for the refusal-guard extension.
//
// The extension is driven exactly the way omp drives it: build a fake
// ExtensionAPI, hand it to the default export, then fire events and assert on
// what comes back. No omp install and no network required.
//
//   node --experimental-strip-types --test tests/

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";

const EXTENSION = pathToFileURL(
  join(import.meta.dirname, "..", "extensions", "refusal-guard.ts"),
).href;

interface Harness {
  fire(event: string, payload: unknown): Promise<unknown>;
  run(command: string, args: string): Promise<void>;
  readonly notices: string[];
  readonly sent: string[];
  readonly logPath: string;
}

let scratch: string;

/**
 * Load a fresh copy of the extension against the given env and wire it to a
 * fake ExtensionAPI. The cache-busting query is what makes each test see its
 * own module-level state and its own env.
 */
async function load(env: Record<string, string | undefined>): Promise<Harness> {
  const logPath = join(scratch, `refusals-${Math.random().toString(36).slice(2)}.jsonl`);
  const previous: Record<string, string | undefined> = {};
  const applied = { OMP_REFUSAL_LOG: logPath, ...env };
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const notices: string[] = [];
  const sent: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (message: string) => void notices.push(message) } };

  const pi = {
    setLabel: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => unknown }) => {
      commands.set(name, def.handler);
    },
    sendMessage: (message: { content: string }) => void sent.push(message.content),
  };

  // Dynamic on purpose: a static import would be evaluated once for the whole
  // file, so every test would share one module instance and one snapshot of the
  // env. The cache-busting specifier gives each test its own load.
  const module: { default: (api: unknown) => void } = await import(
    `${EXTENSION}?t=${Math.random()}`
  );
  module.default(pi);

  // Env only matters during load; restore it so tests stay independent.
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return {
    async fire(event, payload) {
      let last: unknown;
      for (const handler of handlers.get(event) ?? []) {
        last = await handler(payload, ctx);
      }
      return last;
    },
    async run(command, args) {
      const handler = commands.get(command);
      assert.ok(handler, `command /${command} is not registered`);
      await handler(args, ctx);
    },
    notices,
    sent,
    logPath,
  };
}

const refusalMessage = {
  role: "assistant",
  model: "claude-fable-5",
  stopReason: "error",
  stopDetails: {
    type: "refusal",
    category: "cyber",
    explanation: "This request was declined because it could enable cyber harm.",
  },
};

/** A mid-stream refusal: the model spoke, then the classifier cut it off. */
const partialTextRefusal = {
  ...refusalMessage,
  content: [{ type: "text", text: "Here is how the auth flow works" }],
};

/** A mid-stream refusal that left a tool call with no result behind. */
const partialToolRefusal = {
  ...refusalMessage,
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
};

/** Thinking is not observable work, so this still counts as a silent refusal. */
const thinkingOnlyRefusal = {
  ...refusalMessage,
  content: [{ type: "thinking", thinking: "considering the request" }],
};

const stopEvent = { type: "session_stop", turn_id: 1, stop_hook_active: false };

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "refusal-guard-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a refused turn is continued instead of dead-stopping", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  const result = await h.fire("session_stop", stopEvent);

  assert.deepEqual(
    typeof result === "object" && result !== null && "continue" in result
      ? result.continue
      : undefined,
    true,
  );
  const context =
    typeof result === "object" && result !== null && "additionalContext" in result
      ? String(result.additionalContext)
      : "";
  assert.match(context, /safety classifier/);
  assert.match(context, /category: cyber/);
  assert.match(context, /do not stop silently/);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /Classifier refusal \(cyber\)/);
});

test("the rescue cap survives a continuation that opens a new turn", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  const first = await h.fire("session_stop", stopEvent);
  assert.ok(first, "the first refusal should be rescued");

  // The continuation opens its own turn. A turn-scoped guard would reset here
  // and rescue again, looping until the runtime's continuation cap.
  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  const second = await h.fire("session_stop", stopEvent);

  assert.equal(second, undefined);
});

test("the rescue cap lifts once a turn actually produces output", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  await h.fire("session_stop", stopEvent);

  // A later turn answers normally, so a refusal after it is a fresh incident.
  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", {
    type: "message_end",
    message: { role: "assistant", model: "claude-opus-4-8", stopReason: "stop" },
  });
  await h.fire("session_stop", stopEvent);

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  const later = await h.fire("session_stop", stopEvent);

  assert.ok(later, "a refusal after real output should be rescued again");
});

test("an abandoned refusal does not leak a rescue into the next turn", async () => {
  const h = await load({});

  // Refusal, then the turn is abandoned before session_stop ever fires.
  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });

  await h.fire("turn_start", { type: "turn_start" });
  const next = await h.fire("session_stop", stopEvent);

  assert.equal(next, undefined);
  const outcomes = readFileSync(h.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line).outcome);
  assert.deepEqual(outcomes, ["dead"]);
});

test("a clean turn is never continued", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", {
    type: "message_end",
    message: { role: "assistant", model: "claude-fable-5", stopReason: "stop" },
  });
  const result = await h.fire("session_stop", stopEvent);

  assert.equal(result, undefined);
  assert.equal(h.notices.length, 0);
});

test("rescue can be switched off", async () => {
  const h = await load({ OMP_REFUSAL_RESCUE: "off" });

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  const result = await h.fire("session_stop", stopEvent);

  assert.equal(result, undefined);
});

test("a fallback that answered is recorded as recovered, not dead", async () => {
  const h = await load({ OMP_REFUSAL_RESCUE: "off" });

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  await h.fire("message_end", {
    type: "message_end",
    message: { role: "assistant", model: "claude-opus-4-8", stopReason: "stop" },
  });
  await h.fire("session_stop", stopEvent);

  const records = readFileSync(h.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "fallback");
  assert.equal(records[0].category, "cyber");
  assert.equal(records[0].model, "claude-fable-5");
});

test("the server-side chain is retargeted when one is already present", async () => {
  const h = await load({ OMP_REFUSAL_FALLBACKS: "claude-opus-4-8, claude-sonnet-5" });

  const result = await h.fire("before_provider_request", {
    type: "before_provider_request",
    payload: { model: "claude-fable-5", fallbacks: [{ model: "claude-opus-4-8" }] },
  });

  assert.deepEqual(result, {
    model: "claude-fable-5",
    fallbacks: [{ model: "claude-opus-4-8" }, { model: "claude-sonnet-5" }],
  });
});

test("no chain is injected where none existed, so the beta header cannot go missing", async () => {
  const h = await load({ OMP_REFUSAL_FALLBACKS: "claude-opus-4-8" });

  const result = await h.fire("before_provider_request", {
    type: "before_provider_request",
    payload: { model: "claude-fable-5" },
  });

  assert.equal(result, undefined);
});

test("the active model is never listed as its own fallback", async () => {
  const h = await load({ OMP_REFUSAL_FALLBACKS: "claude-opus-4-8" });

  const result = await h.fire("before_provider_request", {
    type: "before_provider_request",
    payload: { model: "claude-opus-4-8", fallbacks: [{ model: "claude-opus-4-8" }] },
  });

  assert.equal(result, undefined);
});

test("/refusals reports what tripped", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  await h.fire("session_stop", stopEvent);
  await h.run("refusals", "");

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /1 refusal\(s\) recorded/);
  assert.match(h.sent[0], /cyber/);
  assert.match(h.sent[0], /claude-fable-5/);
  assert.match(h.sent[0], /rescued/);
});

test("a refusal that already emitted text is left alone, not re-prompted", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: partialTextRefusal });
  const result = await h.fire("session_stop", stopEvent);

  assert.equal(result, undefined);
  const outcomes = readFileSync(h.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line).outcome);
  assert.deepEqual(outcomes, ["partial"]);
});

test("a refusal that left a dangling tool call is left alone", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: partialToolRefusal });
  const result = await h.fire("session_stop", stopEvent);

  assert.equal(result, undefined);
});

test("a refusal carrying only thinking is still rescued", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: thinkingOnlyRefusal });
  const result = await h.fire("session_stop", stopEvent);

  assert.ok(result, "thinking is not observable output, so the turn is still silent");
});

/** Google reports a block as an ordinary error carrying omp's ContentBlocked flag. */
const googleBlock = {
  role: "assistant",
  model: "gemini-3-pro",
  stopReason: "error",
  errorId: 32768,
  errorMessage: "Request blocked by Google (SAFETY)",
};

/** OpenAI chat-completions reports it as error text with no flag. */
const openaiBlock = {
  role: "assistant",
  model: "gpt-5.2",
  stopReason: "error",
  errorMessage: "Provider finish_reason: content_filter",
};

test("a Google content block is detected via omp's ContentBlocked flag", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: googleBlock });
  const result = await h.fire("session_stop", stopEvent);

  assert.ok(result, "a flagged content block should be rescued like a Claude refusal");
  const record = JSON.parse(readFileSync(h.logPath, "utf8").trim());
  assert.equal(record.model, "gemini-3-pro");
  assert.equal(record.category, "content-blocked");
  assert.equal(record.explanation, "Request blocked by Google (SAFETY)");
});

test("an OpenAI content_filter is detected from the error text alone", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: openaiBlock });
  const result = await h.fire("session_stop", stopEvent);

  assert.ok(result, "an unflagged content_filter should still be caught");
});

test("an ordinary provider error is not mistaken for a content block", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      model: "gpt-5.2",
      stopReason: "error",
      errorId: 2048,
      errorMessage: "Overloaded: please retry your request",
    },
  });
  const result = await h.fire("session_stop", stopEvent);

  assert.equal(result, undefined);
});
