/**
 * SC-001's replay (specs/006 research R13, T026): thirty labelled sentences,
 * stored as hashes with their held-token context and the orders the founder
 * says they mean. At least 27 must give the labelled orders and none a wrong
 * one (a sell for a buy, another token, another level).
 *
 * The file never holds the words, so a live run needs them from outside the
 * repo: SENTENCE_EVAL_TEXTS names a local JSON array of the sentences, each
 * hashed under BOT_KEY_SECRET to find its label, and ANTHROPIC_API_KEY asks
 * the model. SENTENCE_EVAL_RECORD=1 writes each tool input to fixture.json,
 * keyed by hash, and every other run replays that fixture. Skipped, saying
 * so, until the set has thirty entries.
 *
 *   npm run build:fleet && node --test dist-fleet/test/fleet/eval/sentences.test.js
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { checkResult, createAnthropicTranslator, hashSentence, type Proposal, type TranslationResult } from "../../../src/fleet/bot-sentence-translate.js";

type Expect = { kind: Proposal["kind"]; token: string; size?: string; level?: string };
type Entry = { hash: string; context: { held: { symbol: string; tail: string }[]; perEth: Record<string, string> }; expect: Expect[] };

const here = (name: string): string => new URL(`../../../../test/fleet/eval/${name}`, import.meta.url).pathname;
const entries = JSON.parse(readFileSync(here("sentences.json"), "utf8")) as Entry[];
const fixturePath = here("fixture.json");
const fixture: Record<string, unknown> = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : {};
const NEEDED = 30;

/** A proposal in the label's words: the token as a symbol, a share as N%, an ETH size as is, a level as Nx, N% or an ETH price. */
const said = (p: Proposal): Expect => ({
  kind: p.kind,
  token: p.tokenText.replace(/^\$/, "").toUpperCase(),
  ...(p.size ? { size: "pct" in p.size ? `${p.size.pct}%` : p.size.eth } : {}),
  ...(p.level ? { level: "multiple" in p.level ? `${p.level.multiple}x` : "percent" in p.level ? `${p.level.percent}%` : p.level.eth } : {}),
});
const same = (a: Expect, b: Expect): boolean => a.kind === b.kind && a.token === b.token.toUpperCase() && a.size === b.size && a.level === b.level;

/** A match is the labelled orders exactly; a wrong order is any order given that the label does not have (a question or none is a miss, never wrong). */
export const score = (got: TranslationResult, expect: Expect[]): "match" | "miss" | "wrong" => {
  if (got.kind !== "orders") return expect.length === 0 ? "match" : "miss";
  const given = got.proposals.map(said);
  if (given.length === expect.length && given.every((g, i) => same(g, expect[i]!))) return "match";
  return given.some((g) => !expect.some((e) => same(g, e))) ? "wrong" : "miss";
};

/** The result as the tool gave it: the bot's own "cut to three" mark is not the model's. */
const toolInput = (r: TranslationResult): TranslationResult => (r.kind === "orders" ? { kind: "orders", proposals: r.proposals } : r);

const liveTexts = (): Map<string, string> => {
  const path = process.env.SENTENCE_EVAL_TEXTS, secret = process.env.BOT_KEY_SECRET;
  if (!path || !secret || !process.env.ANTHROPIC_API_KEY) return new Map();
  return new Map((JSON.parse(readFileSync(path, "utf8")) as string[]).map((t) => [hashSentence(secret, t), t]));
};

test("SC-001: at least 27 of the 30 labelled sentences give the labelled card, and none a wrong order", { skip: entries.length < NEEDED ? `skipped: ${entries.length} of ${NEEDED} sentences` : false }, async () => {
  const texts = liveTexts();
  const live = texts.size > 0 ? createAnthropicTranslator({ apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.BOT_SENTENCE_MODEL || "claude-haiku-5-5", fetch: (i, init) => fetch(i, init) }) : undefined;
  const tally = { match: 0, miss: 0, wrong: 0 };
  for (const entry of entries) {
    const text = texts.get(entry.hash);
    let got: TranslationResult | undefined;
    if (live && text) {
      const answer = await live.translate({ sentence: text, held: entry.context.held, now: Object.fromEntries(Object.entries(entry.context.perEth).map(([k, v]) => [k, { perEth: v }])) });
      if (answer.ok) { got = answer.result; if (process.env.SENTENCE_EVAL_RECORD === "1") fixture[entry.hash] = { result: toolInput(answer.result) }; }
    } else got = entry.hash in fixture ? checkResult(fixture[entry.hash]) : undefined;
    const verdict = got ? score(got, entry.expect) : "miss";
    tally[verdict] += 1;
    if (verdict !== "match") console.log(`${verdict}: ${entry.hash.slice(0, 12)}`);
  }
  if (process.env.SENTENCE_EVAL_RECORD === "1") writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`SC-001: ${tally.match} of ${entries.length} match, ${tally.wrong} wrong`);
  assert.equal(tally.wrong, 0, "no sentence may become a wrong order");
  assert.ok(tally.match >= 27, `${tally.match} of ${entries.length} match; SC-001 needs 27`);
});

test("the scorer: the labelled orders match; a question is a miss; another token, side or level is wrong", () => {
  const tp: Proposal = { kind: "tp", tokenText: "$pepe", size: { pct: 50 }, level: { multiple: 2 } };
  const label: Expect[] = [{ kind: "tp", token: "PEPE", size: "50%", level: "2x" }];
  assert.equal(score({ kind: "orders", proposals: [tp] }, label), "match");
  assert.equal(score({ kind: "question", missing: "size", draft: [] }, label), "miss");
  assert.equal(score({ kind: "none" }, []), "match", "a refusal labelled as one");
  assert.equal(score({ kind: "orders", proposals: [{ ...tp, tokenText: "wif" }] }, label), "wrong");
  assert.equal(score({ kind: "orders", proposals: [{ ...tp, kind: "sl" }] }, label), "wrong");
  assert.equal(score({ kind: "orders", proposals: [{ ...tp, level: { multiple: 3 } }] }, label), "wrong");
});
