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

test("only one rescue per turn, so a stuck refusal cannot loop", async () => {
  const h = await load({});

  await h.fire("turn_start", { type: "turn_start" });
  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  await h.fire("session_stop", stopEvent);

  await h.fire("message_end", { type: "message_end", message: refusalMessage });
  const second = await h.fire("session_stop", stopEvent);

  assert.equal(second, undefined);
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
