/**
 * The sentence translator (bot-sentence-translate.ts, specs/006
 * contracts/translator.md): the hand checker holds the closed schema, a
 * model-written address resolves only when the message pasted it, four
 * proposals become three, the budget ends the call as FR-021's failure,
 * malformed output reads as none, and usage prices in micro-dollars.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { checkResult, createAnthropicTranslator, FakeTranslator, matchToken, PROPOSE_ORDERS, spendMicros, type Proposal } from "../../src/fleet/bot-sentence-translate.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const WIF = "0x00000000000000000000000000000000000000cf" as Address;
const tp: Proposal = { kind: "tp", tokenText: "pepe", size: { pct: 50 }, level: { multiple: 2 } };
const input = { sentence: "sell half pepe at 2x", held: [{ symbol: "PEPE", tail: "00ce" }], now: { "00ce": { perEth: "1000000000000" } } };

test("the checker accepts the three result shapes and refuses any field outside them", () => {
  assert.deepEqual(checkResult({ result: { kind: "none" } }), { kind: "none" });
  assert.deepEqual(checkResult({ result: { kind: "none", note: "mcap" } }), { kind: "none", note: "mcap" });
  assert.deepEqual(checkResult({ result: { kind: "question", missing: "size", draft: [] } }), { kind: "question", missing: "size", draft: [] });
  assert.deepEqual(checkResult({ result: { kind: "orders", proposals: [tp, { kind: "dca", tokenText: "wif", size: { eth: "0.01" }, every: "daily", count: 7 }] } })?.kind, "orders");
  for (const bad of [
    { result: { kind: "none", to: PEPE } },
    { result: { kind: "orders", proposals: [{ ...tp, destination: PEPE }] } },
    { result: { kind: "orders", proposals: [{ ...tp, size: { pct: 50, eth: "1" } }] } },
    { result: { kind: "orders", proposals: [{ ...tp, kind: "transfer" }] } },
    { result: { kind: "orders", proposals: [{ ...tp, size: { eth: "1e18" } }] } },
    { result: { kind: "orders", proposals: [{ ...tp, count: 31 }] } },
    { result: { kind: "orders", proposals: [] } },
    { result: { kind: "question", missing: "price", draft: [] } },
    { result: { kind: "orders", proposals: [tp] }, extra: true },
  ]) assert.equal(checkResult(bad), undefined, JSON.stringify(bad));
});

test("four proposals are cut to the first three and marked, so the card says three at a time", () => {
  const r = checkResult({ result: { kind: "orders", proposals: [tp, tp, tp, { ...tp, tokenText: "wif" }] } });
  assert.ok(r && r.kind === "orders");
  assert.equal(r.proposals.length, 3); assert.equal(r.cut, true);
  assert.ok(r.proposals.every((p) => p.tokenText === "pepe"));
});

test("a token resolves by symbol among the held; an address the model wrote resolves only when pasted", () => {
  const held = [{ symbol: "PEPE", address: PEPE }, { symbol: "WIF", address: WIF }];
  assert.deepEqual(matchToken("$pepe", held), [PEPE]);
  assert.deepEqual(matchToken("bonk", held), []);
  assert.deepEqual(matchToken(WIF, held), [], "not pasted, not resolved, even though it is held");
  assert.deepEqual(matchToken(WIF.toUpperCase().replace("0X", "0x"), held, WIF), [WIF]);
  assert.deepEqual(matchToken(PEPE, held, WIF), []);
});

const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test("the Anthropic call forces the one tool and reads its input; a miss or no tool block is none, marked malformed", async () => {
  let sent: { tool_choice?: unknown; tools?: { name: string }[]; max_tokens?: number } = {}, to = "";
  const ok = createAnthropicTranslator({ apiKey: "k", model: "m", fetch: (async (u: string, init: RequestInit) => { to = u; sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "propose_orders", input: { result: { kind: "orders", proposals: [tp] } } }], usage: { input_tokens: 900, output_tokens: 60 } })); }) as typeof fetch });
  assert.deepEqual(await ok.translate(input), { ok: true, result: { kind: "orders", proposals: [tp] }, usage: { inputTokens: 900, outputTokens: 60 } });
  assert.equal(to, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(sent.tool_choice, { type: "tool", name: PROPOSE_ORDERS.name }); assert.deepEqual(sent.tools?.map((t) => t.name), ["propose_orders"]); assert.equal(sent.max_tokens, 400);
  const text = createAnthropicTranslator({ apiKey: "k", model: "m", fetch: reply({ content: [{ type: "text", text: "sure" }] }) });
  assert.deepEqual(await text.translate(input), { ok: true, result: { kind: "none" }, usage: { inputTokens: 0, outputTokens: 0 }, malformed: true });
  const junk = createAnthropicTranslator({ apiKey: "k", model: "m", fetch: reply({ content: [{ type: "tool_use", name: "propose_orders", input: { result: { kind: "orders", proposals: [{ ...tp, recipient: PEPE }] } } }] }) });
  assert.equal((await junk.translate(input) as { malformed?: true }).malformed, true);
  assert.deepEqual(await createAnthropicTranslator({ apiKey: "k", model: "m", fetch: reply({}, 529) }).translate(input), { ok: false, failure: "status" });
  assert.deepEqual(await createAnthropicTranslator({ apiKey: "k", model: "m", fetch: (async () => { throw new Error("down"); }) as typeof fetch }).translate(input), { ok: false, failure: "network" });
});

test("past the budget the call is aborted and answers timeout; the fake does the same", async () => {
  const hang = (async (_u: string, init: RequestInit) => new Promise<Response>((_, fail) => init.signal?.addEventListener("abort", () => fail(new Error("aborted"))))) as typeof fetch;
  const started = Date.now();
  assert.deepEqual(await createAnthropicTranslator({ apiKey: "k", model: "m", fetch: hang, budgetMs: 30 }).translate(input), { ok: false, failure: "timeout" });
  assert.ok(Date.now() - started < 1_000);
  const slow = new FakeTranslator({ [input.sentence]: { kind: "orders", proposals: [tp] } }, 50, 20);
  assert.deepEqual(await slow.translate(input), { ok: false, failure: "timeout" });
  const fake = new FakeTranslator({ [input.sentence]: { kind: "orders", proposals: [tp] } });
  assert.equal((await fake.translate({ ...input, sentence: "gm" }) as { result: { kind: string } }).result.kind, "none");
  assert.deepEqual(fake.calls, ["gm"]);
});

test("usage prices in micro-dollars at the given per-million prices", () => {
  assert.equal(spendMicros({ inputTokens: 900, outputTokens: 60 }, 1, 5), 1_200n);
  assert.equal(spendMicros({ inputTokens: 0, outputTokens: 0 }, 1, 5), 0n);
  assert.equal(spendMicros({ inputTokens: 1_000_000, outputTokens: 0 }, 0.8, 4), 800_000n, "a million input tokens at $0.80 is 80 cents");
});
