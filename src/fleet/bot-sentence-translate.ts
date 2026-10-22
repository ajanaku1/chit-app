/**
 * The sentence desk's translator (specs/006 contracts/translator.md): one
 * model call per sentence, forced onto the single `propose_orders` tool whose
 * closed schema is the whole contract. The answer is checked again here by
 * hand; anything outside the schema reads as no order. Nothing the model
 * returns can name an address or where funds go: `tokenText` is matched by the
 * bot against what the account holds or an address pasted in the message.
 */

import type { Address } from "./types.js";

export type OrderKind = "limit" | "dca" | "tp" | "sl" | "shield";
export type Proposal = {
  kind: OrderKind;
  tokenText: string;
  size?: { pct: number } | { eth: string };
  level?: { multiple: number } | { percent: number } | { eth: string };
  every?: "hourly" | "daily" | "weekly";
  count?: number;
  note?: string;
};
export type Missing = "token" | "size" | "direction";
export type TranslationResult =
  | { kind: "none"; note?: string }
  | { kind: "question"; missing: Missing; draft: Proposal[] }
  | { kind: "orders"; proposals: Proposal[]; cut?: true };
export type Usage = { inputTokens: number; outputTokens: number };
export type TranslateInput = { sentence: string; held: { symbol: string; tail: string }[]; pastedAddress?: string; now: Record<string, { perEth: string }> };
/** A read answer (a malformed one reads as none and says so), or the FR-021 failure class. */
export type Translation =
  | { ok: true; result: TranslationResult; usage: Usage; malformed?: true }
  | { ok: false; failure: "timeout" | "network" | "status" };

export interface Translator { translate(input: TranslateInput): Promise<Translation> }

export const BUDGET_MS = 5_500;
export const MAX_PROPOSALS = 3;
const KINDS: readonly string[] = ["limit", "dca", "tp", "sl", "shield"];
const MISSING: readonly string[] = ["token", "size", "direction"];
const EVERY: readonly string[] = ["hourly", "daily", "weekly"];
const DECIMAL = /^\d+(\.\d+)?$/;
const NONE: TranslationResult = { kind: "none" };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Json, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const shortText = (v: unknown, max: number): boolean => typeof v === "string" && v.length <= max;

const checkSize = (v: unknown): boolean =>
  isObject(v) && ((only(v, ["pct"]) && isNumber(v.pct) && v.pct >= 0) || (only(v, ["eth"]) && typeof v.eth === "string" && DECIMAL.test(v.eth)));

const checkLevel = (v: unknown): boolean =>
  isObject(v) && ((only(v, ["multiple"]) && isNumber(v.multiple) && v.multiple > 0) || (only(v, ["percent"]) && isNumber(v.percent)) || (only(v, ["eth"]) && typeof v.eth === "string" && DECIMAL.test(v.eth)));

const checkProposal = (v: unknown): v is Proposal => {
  if (!isObject(v) || !only(v, ["kind", "tokenText", "size", "level", "every", "count", "note"])) return false;
  if (typeof v.kind !== "string" || !KINDS.includes(v.kind) || !shortText(v.tokenText, 40)) return false;
  if (v.size !== undefined && !checkSize(v.size)) return false;
  if (v.level !== undefined && !checkLevel(v.level)) return false;
  if (v.every !== undefined && (typeof v.every !== "string" || !EVERY.includes(v.every))) return false;
  if (v.count !== undefined && !(Number.isInteger(v.count) && (v.count as number) >= 1 && (v.count as number) <= 30)) return false;
  return v.note === undefined || shortText(v.note, 80);
};

const checkProposals = (v: unknown): Proposal[] | undefined =>
  Array.isArray(v) && v.length >= 1 && v.every(checkProposal) ? (v as Proposal[]) : undefined;

/**
 * The tool input checked against the closed schema; undefined is a miss. More
 * than three proposals is the one shape kept past the schema: the first three,
 * marked cut, so the card can say "three at a time".
 */
export const checkResult = (input: unknown): TranslationResult | undefined => {
  if (!isObject(input) || !only(input, ["result"]) || !isObject(input.result)) return undefined;
  const r = input.result;
  if (r.kind === "none") return only(r, ["kind", "note"]) && (r.note === undefined || shortText(r.note, 80)) ? (r.note === undefined ? NONE : { kind: "none", note: r.note as string }) : undefined;
  if (r.kind === "question") {
    const draft = Array.isArray(r.draft) && r.draft.length === 0 ? [] : checkProposals(r.draft);
    return only(r, ["kind", "missing", "draft"]) && typeof r.missing === "string" && MISSING.includes(r.missing) && draft ? { kind: "question", missing: r.missing as Missing, draft: draft.slice(0, MAX_PROPOSALS) } : undefined;
  }
  if (r.kind !== "orders" || !only(r, ["kind", "proposals"])) return undefined;
  const proposals = checkProposals(r.proposals);
  if (!proposals) return undefined;
  return proposals.length > MAX_PROPOSALS ? { kind: "orders", proposals: proposals.slice(0, MAX_PROPOSALS), cut: true } : { kind: "orders", proposals };
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The held tokens (or the pasted address) a `tokenText` names, research R3.
 * An address the model wrote is matched only when the message itself carried
 * it; a symbol matches case-insensitively, with or without a leading `$`.
 */
export const matchToken = (tokenText: string, held: { symbol: string; address: Address }[], pastedAddress?: string): Address[] => {
  const text = tokenText.trim();
  if (ADDRESS.test(text)) return pastedAddress && text.toLowerCase() === pastedAddress.toLowerCase() ? [pastedAddress.toLowerCase() as Address] : [];
  const name = text.replace(/^\$/, "").toLowerCase();
  return name ? held.filter((h) => h.symbol.toLowerCase() === name).map((h) => h.address) : [];
};

/** USD per million tokens is micro-dollars per token: the call's cost in micro-dollars, rounded. */
export const spendMicros = (usage: Usage, priceIn: number, priceOut: number): bigint =>
  BigInt(Math.round(usage.inputTokens * priceIn + usage.outputTokens * priceOut));

const proposalSchema = {
  type: "object", additionalProperties: false, required: ["kind", "tokenText"],
  properties: {
    kind: { enum: KINDS },
    tokenText: { type: "string", maxLength: 40 },
    size: { oneOf: [
      { type: "object", additionalProperties: false, required: ["pct"], properties: { pct: { type: "number", minimum: 0 } } },
      { type: "object", additionalProperties: false, required: ["eth"], properties: { eth: { type: "string", pattern: DECIMAL.source } } }] },
    level: { oneOf: [
      { type: "object", additionalProperties: false, required: ["multiple"], properties: { multiple: { type: "number", exclusiveMinimum: 0 } } },
      { type: "object", additionalProperties: false, required: ["percent"], properties: { percent: { type: "number" } } },
      { type: "object", additionalProperties: false, required: ["eth"], properties: { eth: { type: "string", pattern: DECIMAL.source } } }] },
    every: { enum: EVERY },
    count: { type: "integer", minimum: 1, maximum: 30 },
    note: { type: "string", maxLength: 80 },
  },
};
const proposals = { type: "array", minItems: 1, maxItems: MAX_PROPOSALS, items: proposalSchema };

export const PROPOSE_ORDERS = {
  name: "propose_orders",
  description: "The orders the trader's message asks for, a question when one thing is missing, or none.",
  input_schema: {
    type: "object", additionalProperties: false, required: ["result"],
    properties: { result: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "none" }, note: { type: "string", maxLength: 80 } } },
      { type: "object", additionalProperties: false, required: ["kind", "missing", "draft"], properties: { kind: { const: "question" }, missing: { enum: MISSING }, draft: { type: "array", maxItems: MAX_PROPOSALS, items: proposalSchema } } },
      { type: "object", additionalProperties: false, required: ["kind", "proposals"], properties: { kind: { const: "orders" }, proposals } }] } },
  },
};

export const systemText = (held: TranslateInput["held"]): string => [
  "You turn one message from a trader into orders for a Telegram trading bot. Answer only through the propose_orders tool.",
  "Order kinds: limit (buy: size.eth, level as eth per token or percent below now), dca (buy: size.eth each, every hourly/daily/weekly, count 1-30), tp (sell: size.pct of the position, level as a multiple like 2 or a percent up), sl (sell: size.pct, level as a percent down), shield (sell all if the pool is pulled; no size, no level).",
  "tokenText is the token exactly as the trader wrote it. Never write an address unless the trader pasted one.",
  "Return none for anything that is not an instruction. Return a question when the token, the size or the direction is missing; never guess.",
  "Market cap levels are not supported: return none with note \"mcap\".",
  held.length ? `The trader holds: ${held.map((h) => `${h.symbol} (…${h.tail})`).join(", ")}.` : "The trader holds no tokens.",
].join("\n");

type AnthropicReply = { content?: { type?: string; name?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number } };

const readReply = (reply: AnthropicReply): Translation => {
  const call = reply.content?.find((c) => c.type === "tool_use" && c.name === PROPOSE_ORDERS.name);
  const usage = { inputTokens: reply.usage?.input_tokens ?? 0, outputTokens: reply.usage?.output_tokens ?? 0 };
  const result = call ? checkResult(call.input) : undefined;
  return result ? { ok: true, result, usage } : { ok: true, result: NONE, usage, malformed: true };
};

export type AnthropicConfig = { apiKey: string; model: string; fetch: typeof fetch; budgetMs?: number; url?: string };

/** The Anthropic Messages API over plain fetch (research R1): one request, aborted at the budget, never retried. */
export const createAnthropicTranslator = (config: AnthropicConfig): Translator => ({
  async translate(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.budgetMs ?? BUDGET_MS);
    try {
      const response = await config.fetch(config.url ?? "https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: config.model, max_tokens: 400, system: systemText(input.held),
          messages: [{ role: "user", content: input.sentence }],
          tools: [PROPOSE_ORDERS], tool_choice: { type: "tool", name: PROPOSE_ORDERS.name },
        }),
      });
      if (!response.ok) return { ok: false, failure: "status" };
      return readReply((await response.json()) as AnthropicReply);
    } catch {
      return { ok: false, failure: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  },
});

/** Tests: the mapped result or none; a delay past the budget is the timeout. `calls` counts every translate. */
export class FakeTranslator implements Translator {
  calls: string[] = [];
  constructor(private readonly map: Record<string, TranslationResult>, private readonly delayMs = 0, private readonly budgetMs = BUDGET_MS) {}
  async translate(input: TranslateInput): Promise<Translation> {
    this.calls.push(input.sentence);
    if (this.delayMs) await new Promise((done) => setTimeout(done, Math.min(this.delayMs, this.budgetMs)));
    if (this.delayMs > this.budgetMs) return { ok: false, failure: "timeout" };
    return { ok: true, result: this.map[input.sentence] ?? NONE, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
