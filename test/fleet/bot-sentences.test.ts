/**
 * The sentence desk (bot-sentences.ts, specs/006 US1): a sentence becomes one
 * Proposed card whose lines are the bot's own order words with each level as
 * a multiple, a percent and an ETH price; Confirm places what the buttons
 * would place, Cancel places nothing; three at a time; one translation per
 * sentence (FR-023) and no persona or returns wording anywhere (FR-024).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { buildExit, type OrderBuildDeps } from "../../src/fleet/bot-order-build.js";
import { MemoryOrderStore, type Order } from "../../src/fleet/bot-orders.js";
import { MemoryPositionLedger } from "../../src/fleet/bot-positions.js";
import { sellPreflight, type SessionChain } from "../../src/fleet/bot-session-chain.js";
import { MemorySentenceStore } from "../../src/fleet/bot-sentence-store.js";
import { FakeTranslator, type Proposal, type TranslationResult } from "../../src/fleet/bot-sentence-translate.js";
import { LINES, SentenceDesk } from "../../src/fleet/bot-sentences.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const WIF = "0x00000000000000000000000000000000000000cf" as Address;
const DRY = "0x00000000000000000000000000000000000000d0" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const clock = new Date("2026-10-22T12:00:00Z");
const PER_ETH = 1_000_000_000_000n;

const HALF_2X: Proposal = { kind: "tp", tokenText: "pepe", size: { pct: 50 }, level: { multiple: 2 } };
const REST_30: Proposal = { kind: "sl", tokenText: "pepe", size: { pct: 50 }, level: { percent: -30 } };
const S = {
  both: "sell half my pepe at 2x and the rest if it drops 30%",
  dip: "buy 0.01 ETH of pepe when it dips 10%",
  dca: "buy 0.005 ETH of pepe every day for 4 days",
  four: "four orders on pepe",
  wif: "buy 0.01 eth of wif at 0.000002 eth",
  dry: "buy 0.01 eth of dry when it dips 10%",
};
const MAP: Record<string, TranslationResult> = {
  [S.both]: { kind: "orders", proposals: [HALF_2X, REST_30] },
  [S.dip]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "pepe", size: { eth: "0.01" }, level: { percent: -10 } }] },
  [S.dca]: { kind: "orders", proposals: [{ kind: "dca", tokenText: "pepe", size: { eth: "0.005" }, every: "daily", count: 4 }] },
  [S.four]: { kind: "orders", proposals: [HALF_2X, REST_30, { kind: "shield", tokenText: "pepe" }], cut: true },
  [S.wif]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "WIF", size: { eth: "0.01" }, level: { eth: "0.000002" } }] },
  [S.dry]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "dry", size: { eth: "0.01" }, level: { percent: -10 } }] },
};

const setup = async () => {
  const reads = {
    chainId: 4663, router: "0x8876789976decbfcbbbe364623c63652db8c0904",
    async tokenInfo(token: Address) { const sym = token === PEPE ? "PEPE" : token === WIF ? "WIF" : "DRY"; return { address: token, symbol: sym, decimals: 6, hasPool: token !== DRY, perEth: token === WIF ? 2n * PER_ETH : PER_ETH, poolEth: parseEther("5"), hooked: false, fee: 3000, poolOnRecord: token !== DRY }; },
    async tokenBalance(token: Address) { return token === PEPE ? 42_000_000n : 0n; },
    async quoteSell(_t: Address, tokensIn: bigint) { return (tokensIn * 10n ** 18n) / PER_ETH; },
  } as unknown as BotChain;
  const session = {
    chainId: 4663,
    async canExecute() { return { ok: true, why: "" }; },
    async sellAllowed() { return true; },
    async canSell(_a: Address, _r: Address, poolKey: { currency1?: Address } | undefined, _in: bigint, minOut: bigint) { const early = sellPreflight(poolKey?.currency1 ?? PEPE, poolKey as never, minOut); return early ? { ok: false, why: early } : { ok: true, why: "" }; },
  } as unknown as SessionChain;
  const orders = new MemoryOrderStore();
  const build: OrderBuildDeps = { reads, session, orders, siteUrl: "https://chit.tools", sellSlippageBps: 300, now: () => clock };
  const links = new MemoryBotLinkStore();
  await links.putLink({ tgId: "7", account: ACCOUNT, owner: ACCOUNT, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  const positions = new MemoryPositionLedger();
  for (const [i, token] of [PEPE, WIF, DRY].entries()) await positions.note({ hash: `0x${String(i + 1).padStart(64, "0")}`, account: ACCOUNT, token, side: "buy", ethWei: parseEther("0.01"), asked: 0n, units: null, at: clock.toISOString() });
  const telegram = new RecordingTelegram();
  const translator = new FakeTranslator(MAP);
  const store = new MemorySentenceStore();
  const hints: string[] = [];
  const desk = new SentenceDesk({ translator, store, telegram, links, positions, build, secret: "s", hint: async (c) => { hints.push(c); }, connect: async () => undefined });
  return { desk, telegram, orders, translator, store, build };
};

type Sent = { kind: string; text: string; messageId?: number; keyboard?: { text: string; callback_data?: string }[][] };
const lastSent = (t: RecordingTelegram): Sent => t.sent.at(-1) as Sent;
const cardId = (t: RecordingTelegram): string => lastSent(t).keyboard!.flat()[0]!.callback_data!.split(":")[1]!;
const open = async (orders: MemoryOrderStore): Promise<Order[]> => orders.openFor("7", 4663);
const strip = ({ id: _i, createdAt: _c, ...rest }: Order) => rest;
const noPersona = (t: RecordingTelegram) => { for (const text of t.texts()) assert.doesNotMatch(text, /\bI think\b|\bsure\b|\breturns?\b|guarantee|\bgains?\b/i, text); };

test("scenario 1: two numbered lines, each level as a multiple, a percent and an ETH price, the footer, Confirm and Cancel", async () => {
  const { desk, telegram, translator } = await setup();
  await desk.handleText("7", "7", S.both);
  const card = lastSent(telegram);
  assert.match(card.text, /<b>PEPE<\/b> · you hold <code>42<\/code> · now <code>0\.000001 ETH<\/code>/);
  assert.match(card.text, /\n1\. 🎯 take profit: sell <code>50%<\/code> of your <b>PEPE<\/b>.* · <code>2\.00×<\/code> · <code>\+100%<\/code> · <code>0\.000002 ETH<\/code>/);
  assert.match(card.text, /\n2\. 🛑 stop loss: sell <code>50%<\/code> of your <b>PEPE<\/b>.* · <code>0\.70×<\/code> · <code>-30%<\/code> · <code>0\.0000007 ETH<\/code>/);
  assert.match(card.text, new RegExp(`${LINES.footer}$`));
  assert.deepEqual(card.keyboard!.flat().map((b) => b.text), ["Confirm", "Cancel"]);
  assert.deepEqual(translator.calls, [S.both], "one translation per sentence (FR-023)");
  noPersona(telegram);
});

test("scenario 2: Confirm places both, as the buttons would, and the card edits to placed with no buttons", async () => {
  const { desk, telegram, orders, build, translator } = await setup();
  await desk.handleText("7", "7", S.both);
  const id = cardId(telegram), cardMsg = telegram.sent.length;
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), undefined);
  const placed = await open(orders);
  assert.deepEqual(placed.map((o) => [o.kind, o.sellPct]), [["tp", 50], ["sl", 50]]);
  const retry = { again: "", buttons: [] };
  const viaButtons = await Promise.all([buildExit(build, { tgId: "7", account: ACCOUNT, token: PEPE, kind: "tp", move: 100, pct: 50 }, retry), buildExit(build, { tgId: "7", account: ACCOUNT, token: PEPE, kind: "sl", move: 30, pct: 50 }, retry)]);
  assert.deepEqual(placed.map(strip), viaButtons.map((b) => strip(b.ok ? b.order : (undefined as never))), "the same orders a tapped TP and SL make");
  const edit = lastSent(telegram);
  assert.equal(edit.kind, "edit"); assert.equal(edit.messageId, cardMsg);
  assert.match(edit.text, /placed\. manage in Positions\.$/); assert.deepEqual(edit.keyboard, []);
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), LINES.already);
  assert.equal((await open(orders)).length, 2, "the second tap places nothing");
  assert.equal(translator.calls.length, 1, "Confirm consults no model");
  noPersona(telegram);
});

test("scenario 3: Cancel places nothing and the card says so", async () => {
  const { desk, telegram, orders } = await setup();
  await desk.handleText("7", "7", S.both);
  const id = cardId(telegram);
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:no`), undefined);
  assert.equal(lastSent(telegram).text, LINES.cancelled);
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), LINES.cancelled);
  assert.equal((await open(orders)).length, 0);
});

test("scenario 4: a limit buy on a dip shows the ETH level and Confirm places it at that level", async () => {
  const { desk, telegram, orders } = await setup();
  await desk.handleText("7", "7", S.dip);
  assert.match(lastSent(telegram).text, /1\. ⏱ limit buy <code>0\.01 ETH<\/code> of <b>PEPE<\/b>.* · <code>-10%<\/code> · <code>0\.0000009 ETH<\/code>/);
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:ok`);
  const [limit] = await open(orders);
  assert.equal(limit?.kind, "limit"); assert.equal(limit?.ethWei, parseEther("0.01")); assert.equal(limit?.triggerPerEth, (PER_ETH * 10_000n) / 9_000n);
});

test("scenario 5: a DCA of 0.005 ETH, daily, four times", async () => {
  const { desk, telegram, orders } = await setup();
  await desk.handleText("7", "7", S.dca);
  assert.match(lastSent(telegram).text, /1\. 🔁 dca <code>0\.005 ETH<\/code> of <b>PEPE<\/b> every 24 hours, 4 left/);
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:ok`);
  const [dca] = await open(orders);
  assert.deepEqual([dca?.kind, dca?.ethWei, dca?.everyMs, dca?.remaining], ["dca", parseEther("0.005"), 24 * 3_600_000, 4]);
});

test("scenario 6: four orders become three and the card says three at a time", async () => {
  const { desk, telegram } = await setup();
  await desk.handleText("7", "7", S.four);
  const text = lastSent(telegram).text;
  assert.match(text, /\n3\. 🛡 rug shield/); assert.doesNotMatch(text, /\n4\. /);
  assert.ok(text.includes(LINES.three));
});

test("a buy of a token traded but not held is priced from its pool at card time; no pool is the existing refusal", async () => {
  const { desk, telegram, orders } = await setup();
  await desk.handleText("7", "7", S.wif);
  assert.match(lastSent(telegram).text, /<b>WIF<\/b> · you hold <code>0<\/code> · now <code>0\.0000005 ETH<\/code>/);
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:ok`);
  assert.equal((await open(orders))[0]?.triggerPerEth, 500_000_000_000n, "0.000002 ETH a WIF is 500000 WIF per ETH");
  await desk.handleText("7", "7", S.dry);
  assert.equal(lastSent(telegram).text, "no ETH pool on the venue for this token, so nothing to order.");
});

test("a new sentence expires the open card in place, and a tap on it places nothing", async () => {
  const { desk, telegram, orders } = await setup();
  await desk.handleText("7", "7", S.both);
  const first = cardId(telegram), firstMsg = telegram.sent.length;
  await desk.handleText("7", "7", S.dip);
  const expired = telegram.sent.find((o) => o.kind === "edit") as Sent;
  assert.equal(expired.messageId, firstMsg); assert.equal(expired.text, LINES.expired);
  assert.equal(await desk.handleCallback("7", "7", `sc:${first}:ok`), LINES.expired);
  assert.equal((await open(orders)).length, 0);
});
