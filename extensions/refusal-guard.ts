// Keeps a Claude safety-classifier refusal from silently killing your turn.
//
// Claude Fable 5 / Mythos 5 / Opus 5 run real-time safety classifiers. When one
// declines, the API returns HTTP 200 with stop_reason "refusal" and a
// stop_details.category such as "cyber" — which routinely false-positives on
// legitimate security work. omp classifies that as a retryable error, but the
// retry chain only proceeds if a fallback model was actually applied; with no
// chain configured the turn ends with no output and the harness just stops.
//
// This extension adds three things on top of the built-ins:
//   1. rescue   — a refused turn that nothing else recovered gets one
//                 continuation carrying a reframing note, instead of dying.
//   2. telemetry— every refusal is appended to a JSONL log; /refusals reports
//                 which categories and models are tripping, and how often a
//                 fallback saved the turn.
//   3. retarget — rewrites the Anthropic server-side `fallbacks` chain so you
//                 pick the target models instead of the hardcoded default.
//
// Works in Pi and OMP (Oh My Pi).

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Minimal structural types for just the extension-API surface used here.
// Declaring them locally keeps the package harness-agnostic (Pi and OMP both
// provide a superset at runtime) and free of any type-only dependency.
interface ExtensionUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}
interface ExtensionContext {
  hasUI: boolean;
  ui: ExtensionUI;
}
interface SessionStopResult {
  continue: boolean;
  additionalContext?: string;
}
type EventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;
interface ExtensionAPI {
  on(event: string, handler: EventHandler): void;
  registerCommand(
    name: string,
    def: {
      description: string;
      handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
    },
  ): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      attribution?: "user" | "assistant" | "system";
    },
    options?: { triggerTurn?: boolean },
  ): void;
}

// ---------------------------------------------------------------- settings --

/**
 * Settings are read from `OMP_REFUSAL_*` or the `PI_REFUSAL_*` alias, so the
 * same package configures cleanly on either harness.
 */
function setting(name: string): string | undefined {
  return process.env[`OMP_REFUSAL_${name}`] ?? process.env[`PI_REFUSAL_${name}`];
}

/**
 * One log across both harnesses, so refusals stay in a single place no matter
 * which agent hit them. Override with `OMP_REFUSAL_LOG` / `PI_REFUSAL_LOG`.
 */
const LOG_PATH = setting("LOG") ?? join(homedir(), ".refusal-guard", "refusals.jsonl");

/** Anthropic accepts at most three server-side fallback entries. */
const MAX_FALLBACKS = 3;

/** Env values that read as "off"; anything else present reads as "on". */
const OFF_PATTERN = /^(0|off|false|no)$/i;

// ------------------------------------------------------------- refusal I/O --

interface RefusalRecord {
  ts: string;
  model: string | null;
  category: string | null;
  explanation: string | null;
  /**
   * How the turn ended up. `fallback` — a later model answered; `rescued` — this
   * extension continued it; `partial` — output had already been emitted, so it
   * was left alone; `dead` — nothing recovered it.
   */
  outcome: "pending" | "fallback" | "rescued" | "partial" | "dead";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface Refusal {
  model: string | null;
  category: string | null;
  explanation: string | null;
  /**
   * Whether the model had already emitted text or a tool call before the
   * classifier cut it off. Anthropic refuses either before any output or
   * mid-stream, and omp lets a refusal bypass its usual "already produced
   * output" retry exclusion — so this has to be checked here.
   */
  partial: boolean;
}

/**
 * `Flag.ContentBlocked` from `@oh-my-pi/pi-ai`. omp sets this bit on
 * `AssistantMessage.errorId` when a provider refused on content grounds —
 * Google `promptFeedback.blockReason`, an OpenAI Responses
 * `incomplete: content_filter`, and anything else it classifies the same way.
 * Mirrored as a literal so the package keeps no dependency on omp.
 */
const CONTENT_BLOCKED_FLAG = 32768;

/**
 * Provider wordings for a content block on paths that report it as plain error
 * text rather than a flag — notably an OpenAI chat-completions
 * `finish_reason: content_filter`.
 */
const CONTENT_BLOCK_PATTERN = /\bcontent[_ ]?filter\b|\bblocked by google\b/i;

/**
 * Pull decline details off an assistant message.
 *
 * Anthropic is the rich case: a classifier decline arrives as stopReason
 * "error" with a structured `stopDetails` naming the category (`cyber`, `bio`,
 * …). Some paths surface it as `sensitive` instead.
 *
 * Every other provider reports a content block as an ordinary error, so it is
 * recognised through omp's `ContentBlocked` error flag or, failing that, the
 * error text. Those carry no category, so they are filed as `content-blocked`.
 */
function readRefusal(message: unknown): Refusal | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error") return undefined;

  // Thinking blocks are not observable work, so they do not count as partial.
  const content = message.content;
  const partial =
    Array.isArray(content) &&
    content.some((block) => {
      if (!isRecord(block)) return false;
      if (block.type === "toolCall") return true;
      return block.type === "text" && typeof block.text === "string" && block.text.trim() !== "";
    });
  const model = readString(message, "model");

  const details = message.stopDetails;
  if (isRecord(details) && (details.type === "refusal" || details.type === "sensitive")) {
    return {
      model,
      category: readString(details, "category"),
      explanation: readString(details, "explanation"),
      partial,
    };
  }

  const errorId = message.errorId;
  const flagged = typeof errorId === "number" && (errorId & CONTENT_BLOCKED_FLAG) !== 0;
  const errorMessage = readString(message, "errorMessage");
  if (!flagged && !(errorMessage !== null && CONTENT_BLOCK_PATTERN.test(errorMessage))) {
    return undefined;
  }
  return { model, category: "content-blocked", explanation: errorMessage, partial };
}

function appendLog(record: RefusalRecord): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Telemetry must never break a session.
  }
}

function readLog(): RefusalRecord[] {
  let raw: string;
  try {
    raw = readFileSync(LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const out: RefusalRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.ts === "string") {
        out.push(parsed as unknown as RefusalRecord);
      }
    } catch {
      // Skip a torn line rather than losing the whole log.
    }
  }
  return out;
}

function tally(values: (string | null)[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value ?? "(uncategorized)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summarize(records: RefusalRecord[]): string {
  if (records.length === 0) {
    return `No classifier refusals recorded.\nLog: ${LOG_PATH}`;
  }
  const lines: string[] = [`${records.length} refusal(s) recorded — ${LOG_PATH}`, ""];

  lines.push("By category:");
  for (const [name, count] of tally(records.map((r) => r.category))) {
    lines.push(`  ${count.toString().padStart(4)}  ${name}`);
  }

  lines.push("", "By model:");
  for (const [name, count] of tally(records.map((r) => r.model))) {
    lines.push(`  ${count.toString().padStart(4)}  ${name}`);
  }

  lines.push("", "Outcome:");
  for (const [name, count] of tally(records.map((r) => r.outcome))) {
    lines.push(`  ${count.toString().padStart(4)}  ${name}`);
  }

  const recent = records.slice(-5).reverse();
  lines.push("", "Most recent:");
  for (const record of recent) {
    const category = record.category ?? "(uncategorized)";
    const explanation = record.explanation ?? "no explanation given";
    lines.push(`  ${record.ts}  ${record.model ?? "?"}  [${category}] ${explanation}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- entry point --

export default function refusalGuard(pi: ExtensionAPI): void {
  // No setLabel call here, on purpose. omp uses it to name the extension, but
  // Pi's setLabel renames a session entry and throws "Entry ... not found"; at
  // module-load time it throws ExtensionRuntimeNotInitializedError instead,
  // which aborts the whole agent. The message box is titled by the customType
  // on sendMessage, so nothing is lost by leaving it out.

  const rescueRaw = setting("RESCUE")?.trim();
  let rescueEnabled = rescueRaw === undefined || !OFF_PATTERN.test(rescueRaw);
  const fallbackChain = (setting("FALLBACKS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_FALLBACKS);

  /** Refusal seen in the current turn that nothing has recovered yet. */
  let pending:
    | { category: string | null; explanation: string | null; partial: boolean }
    | undefined;
  /** Log entry for `pending`, so its outcome can be amended once known. */
  let pendingRecord: RefusalRecord | undefined;
  /**
   * Rescues since the last turn that actually produced output. Deliberately not
   * reset on `turn_start`: a rescue continuation may itself open a new turn, so
   * a turn-scoped guard would reset itself and let a persistently-refusing
   * model rescue over and over. Only real output clears this.
   */
  let rescueStreak = 0;

  function settle(outcome: RefusalRecord["outcome"]): void {
    if (pendingRecord && pendingRecord.outcome === "pending") {
      pendingRecord.outcome = outcome;
      appendLog(pendingRecord);
    }
    pending = undefined;
    pendingRecord = undefined;
  }

  // A refusal that never reached settle-time (aborted turn, session switch)
  // must not leak into the next turn and trigger a rescue there.
  pi.on("turn_start", () => {
    if (pending) settle("dead");
  });

  // Record every classifier refusal, and remember it as unrecovered.
  pi.on("message_end", (event, ctx) => {
    if (!isRecord(event)) return;
    const refusal = readRefusal(event.message);
    if (!refusal) {
      // Real output: whatever was pending got recovered, and the streak that
      // guards against endless rescues is cleared.
      if (isRecord(event.message) && event.message.role === "assistant") {
        settle("fallback");
        rescueStreak = 0;
      }
      return;
    }
    pending = {
      category: refusal.category,
      explanation: refusal.explanation,
      partial: refusal.partial,
    };
    pendingRecord = {
      ts: new Date().toISOString(),
      model: refusal.model,
      category: refusal.category,
      explanation: refusal.explanation,
      outcome: "pending",
    };
    if (ctx.hasUI) {
      const named = refusal.category ?? "unspecified";
      ctx.ui.notify(`Classifier refusal (${named}) on ${refusal.model ?? "model"}`, "warning");
    }
  });

  // A refused turn that reached settle-time was not recovered by the built-in
  // fallback chain. Give it one continuation instead of a silent dead stop —
  // but only one, until some turn actually produces output again.
  pi.on("session_stop", (event): SessionStopResult | undefined => {
    if (!isRecord(event)) return undefined;
    if (event.stop_hook_active === true) return undefined;
    if (!pending) return undefined;
    if (pending.partial) {
      // The model already emitted text or a tool call before being cut off, so
      // this was not a silent dead stop. Re-prompting would risk duplicating
      // work the user can already see; record it and leave the turn alone.
      settle("partial");
      return undefined;
    }
    if (!rescueEnabled || rescueStreak > 0) {
      settle("dead");
      return undefined;
    }
    const named = pending.category ?? "unspecified";
    const detail = pending.explanation ? ` The API said: ${pending.explanation}` : "";
    // Reframes the task honestly; it does not attempt to defeat the classifier.
    const note =
      `Your previous response was declined by the provider's safety classifier ` +
      `(category: ${named}) and produced no output.${detail}` +
      `\n\nThis frequently misfires on legitimate defensive-security, ` +
      `vulnerability-analysis, and infrastructure work. Continue the task: restate ` +
      `what you were about to do in concrete, defensive terms (what is being ` +
      `protected, which system, why the user is authorized), and proceed. If the ` +
      `request genuinely cannot be answered, say so plainly and explain what you ` +
      `can do instead — do not stop silently.`;
    rescueStreak += 1;
    settle("rescued");
    return { continue: true, additionalContext: note };
  });

  // Retarget Anthropic's server-side fallback chain.
  //
  // Rewrite-only by design: the `server-side-fallback` beta header is assembled
  // from the request options *before* this hook runs, so a `fallbacks` array
  // injected where none existed would be sent without its beta header and
  // rejected. Enable `providers.anthropic.serverSideFallback` to get the header
  // (and the default chain), then this swaps in the models you chose.
  if (fallbackChain.length > 0) {
    pi.on("before_provider_request", (event) => {
      if (!isRecord(event)) return undefined;
      const payload = event.payload;
      if (!isRecord(payload)) return undefined;
      if (!Array.isArray(payload.fallbacks) || payload.fallbacks.length === 0) {
        return undefined;
      }
      const model = payload.model;
      const chain = fallbackChain
        .filter((candidate) => candidate !== model)
        .map((candidate) => ({ model: candidate }));
      if (chain.length === 0) return undefined;
      return { ...payload, fallbacks: chain };
    });
  }

  pi.registerCommand("refusals", {
    description: "Report Claude safety-classifier refusals (add: clear | on | off)",
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "clear") {
        try {
          rmSync(LOG_PATH, { force: true });
        } catch {
          // Nothing to clear.
        }
        if (ctx.hasUI) ctx.ui.notify("Refusal log cleared", "info");
        return;
      }

      if (arg === "on" || arg === "off") {
        rescueEnabled = arg === "on";
        if (ctx.hasUI) {
          ctx.ui.notify(`Refusal rescue ${rescueEnabled ? "enabled" : "disabled"}`, "info");
        }
        return;
      }

      const header = [
        `rescue: ${rescueEnabled ? "on" : "off"}`,
        `server-side chain: ${fallbackChain.length > 0 ? fallbackChain.join(" → ") : "(built-in default)"}`,
        "",
      ].join("\n");

      pi.sendMessage(
        {
          customType: "refusal-guard",
          content: `${header}${summarize(readLog())}`,
          display: true,
          attribution: "system",
        },
        { triggerTurn: false },
      );
    },
  });
}
