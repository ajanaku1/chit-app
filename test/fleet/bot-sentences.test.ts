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
import { CEILING, SHIELD_ON, buildExit, buildShield, type OrderBuildDeps } from "../../src/fleet/bot-order-build.js";
import { MAX_OPEN_ORDERS, MemoryOrderStore, newOrderId, type Order } from "../../src/fleet/bot-orders.js";
import { MemoryPositionLedger } from "../../src/fleet/bot-positions.js";
import { sellPreflight, type SessionChain } from "../../src/fleet/bot-session-chain.js";
import { MemorySentenceStore } from "../../src/fleet/bot-sentence-store.js";
import { FakeTranslator, hashSentence, type Proposal, type Translation, type TranslationResult, type Translator } from "../../src/fleet/bot-sentence-translate.js";
import { ALL_OF_IT } from "../../src/fleet/bot-sentence-questions.js";
import { CARD_MS, LINES, SentenceDesk, sweepCards, type SentenceLimits } from "../../src/fleet/bot-sentences.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const WIF = "0x00000000000000000000000000000000000000cf" as Address;
const DRY = "0x00000000000000000000000000000000000000d0" as Address;
const PEPE2 = "0x00000000000000000000000000000000000000d1" as Address;
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
  twoPepes: "stop loss on all my pepe at -20%",
  at50: "pepe at 50%",
  some: "buy some pepe",
  noEvery: "buy 0.005 eth of pepe 4 times",
  doge: "sell my doge",
  over: "sell 150% of my pepe at 2x",
  tp3x: "sell all my pepe at 3x",
  sl20: "stop loss all my pepe at -20%",
  shield: "shield my pepe",
  big: "buy 0.2 eth of pepe when it dips 10%",
};
const MAP: Record<string, TranslationResult> = {
  [S.both]: { kind: "orders", proposals: [HALF_2X, REST_30] },
  [S.dip]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "pepe", size: { eth: "0.01" }, level: { percent: -10 } }] },
  [S.dca]: { kind: "orders", proposals: [{ kind: "dca", tokenText: "pepe", size: { eth: "0.005" }, every: "daily", count: 4 }] },
  [S.four]: { kind: "orders", proposals: [HALF_2X, REST_30, { kind: "shield", tokenText: "pepe" }], cut: true },
  [S.wif]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "WIF", size: { eth: "0.01" }, level: { eth: "0.000002" } }] },
  [S.dry]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "dry", size: { eth: "0.01" }, level: { percent: -10 } }] },
  [S.twoPepes]: { kind: "orders", proposals: [{ kind: "sl", tokenText: "pepe", size: { pct: 100 }, level: { percent: -20 } }] },
  [S.at50]: { kind: "question", missing: "direction", draft: [{ kind: "tp", tokenText: "pepe", level: { percent: 50 } }] },
  [S.some]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "pepe" }] },
  [S.doge]: { kind: "orders", proposals: [{ kind: "sl", tokenText: "doge", size: { pct: 100 }, level: { percent: -20 } }] },
  [S.over]: { kind: "orders", proposals: [{ kind: "tp", tokenText: "pepe", size: { pct: 150 }, level: { multiple: 2 } }] },
  [S.tp3x]: { kind: "orders", proposals: [{ kind: "tp", tokenText: "pepe", size: { pct: 100 }, level: { multiple: 3 } }] },
  [S.sl20]: { kind: "orders", proposals: [{ kind: "sl", tokenText: "pepe", size: { pct: 100 }, level: { percent: -20 } }] },
  [S.shield]: { kind: "orders", proposals: [{ kind: "shield", tokenText: "pepe" }] },
  [S.big]: { kind: "orders", proposals: [{ kind: "limit", tokenText: "pepe", size: { eth: "0.2" }, level: { percent: -10 } }] },
  [S.noEvery]: { kind: "orders", proposals: [{ kind: "dca", tokenText: "pepe", size: { eth: "0.005" }, count: 4 }] },
};

const setup = async (o: { twoPepes?: boolean; limits?: Partial<SentenceLimits>; translator?: Translator } = {}) => {
  let now = clock;
  const price = { pepe: PER_ETH };
  const st = { exists: true, paused: false, revoked: false, expiry: Math.floor(clock.getTime() / 1000) + 86_400, maxValuePerCall: parseEther("0.05").toString(), totalValueCap: parseEther("0.5").toString(), spentValue: "0", calls: 0 };
  const connects: string[] = [];
  const reads = {
    chainId: 4663, router: "0x8876789976decbfcbbbe364623c63652db8c0904",
    async tokenInfo(token: Address) { const sym = token === PEPE || token === PEPE2 ? "PEPE" : token === WIF ? "WIF" : "DRY"; return { address: token, symbol: sym, decimals: 6, hasPool: token !== DRY, perEth: token === WIF ? 2n * PER_ETH : token === PEPE ? price.pepe : PER_ETH, poolEth: parseEther("5"), hooked: false, fee: 3000, poolOnRecord: token !== DRY }; },
    async tokenBalance(token: Address) { return token === PEPE ? 42_000_000n : token === PEPE2 ? 7_000_000n : 0n; },
    async quoteSell(_t: Address, tokensIn: bigint) { return (tokensIn * 10n ** 18n) / PER_ETH; },
  } as unknown as BotChain;
  const session = {
    chainId: 4663,
    async sessionOf() { return st; },
    async canExecute() { return st.paused ? { ok: false, why: "paused" } : { ok: true, why: "" }; },
    async sellAllowed() { return true; },
    async canSell(_a: Address, _r: Address, poolKey: { currency1?: Address } | undefined, _in: bigint, minOut: bigint) { const early = sellPreflight(poolKey?.currency1 ?? PEPE, poolKey as never, minOut); return early ? { ok: false, why: early } : st.paused ? { ok: false, why: "paused" } : { ok: true, why: "" }; },
  } as unknown as SessionChain;
  const orders = new MemoryOrderStore();
  const build: OrderBuildDeps = { reads, session, orders, siteUrl: "https://chit.tools", sellSlippageBps: 300, now: () => now };
  const links = new MemoryBotLinkStore();
  await links.putLink({ tgId: "8", account: ACCOUNT, owner: ACCOUNT, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  await links.putLink({ tgId: "7", account: ACCOUNT, owner: ACCOUNT, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  const positions = new MemoryPositionLedger();
  for (const [i, token] of [PEPE, WIF, DRY, ...(o.twoPepes ? [PEPE2] : [])].entries()) await positions.note({ hash: `0x${String(i + 1).padStart(64, "0")}`, account: ACCOUNT, token, side: "buy", ethWei: parseEther("0.01"), asked: 0n, units: null, at: clock.toISOString() });
  const telegram = new RecordingTelegram();
  // The FakeTranslator unless a test brings its own; only the fake's `calls` are read.
  const translator = (o.translator ?? new FakeTranslator(MAP)) as FakeTranslator;
  const store = new MemorySentenceStore();
  const hints: string[] = [];
  const desk: SentenceDesk = new SentenceDesk({ translator, store, telegram, links, positions, build, secret: "s", hint: async (c) => { hints.push(c); }, connect: async (c) => { connects.push(c); }, ...(o.limits ? { limits: o.limits } : {}) });
  return { desk, telegram, orders, translator, store, build, hints, links, price, st, connects, later: (ms: number) => { now = new Date(now.getTime() + ms); } };
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

const labels = (t: RecordingTelegram): string[] => lastSent(t).keyboard!.flat().map((b) => b.text);
const datas = (t: RecordingTelegram): string[] => lastSent(t).keyboard!.flat().map((b) => b.callback_data!);

test("US2 scenario 1: two held PEPEs ask which, with address tails, and no card until one is tapped", async () => {
  const { desk, telegram, orders } = await setup({ twoPepes: true });
  await desk.handleText("7", "7", S.twoPepes);
  assert.match(lastSent(telegram).text, /^which PEPE\?/);
  assert.deepEqual(labels(telegram), ["PEPE …00ce", "PEPE …00d1", "Cancel"]);
  assert.deepEqual(datas(telegram), ["sq:7:0", "sq:7:1", "sq:7:x"]);
  assert.ok(!telegram.texts().some((t) => t.includes(LINES.footer)), "no card yet");
  const asked = telegram.sent.length;
  assert.equal(await desk.handleCallback("7", "7", "sq:7:1", asked), undefined);
  assert.deepEqual(telegram.sent.at(-2), { kind: "edit", chatId: "7", messageId: asked, text: "PEPE …00d1", keyboard: [] });
  assert.match(lastSent(telegram).text, /<b>PEPE<\/b> · you hold <code>7<\/code>/);
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:ok`);
  assert.equal((await open(orders))[0]?.token, PEPE2);
  assert.equal(await desk.handleCallback("7", "7", "sq:7:0", asked), LINES.questionGone, "the question is answered once");
  noPersona(telegram);
});

test("US2 scenario 2: a bare move asks take profit or stop loss; the answer gives the card, a share left unsaid shown as all of it", async () => {
  const { desk, telegram } = await setup();
  await desk.handleText("7", "7", S.at50);
  assert.equal(lastSent(telegram).text, "take profit or stop loss?");
  assert.deepEqual(labels(telegram), ["take profit at +50%", "stop loss at −50%", "Cancel"]);
  await desk.handleCallback("7", "7", "sq:7:0");
  const card = lastSent(telegram).text;
  assert.match(card, /1\. 🎯 take profit: sell <code>100%<\/code>.* · <code>1\.50×<\/code> · <code>\+50%<\/code>/);
  assert.ok(card.includes(ALL_OF_IT));
});

test("US2 scenario 3: a new sentence drops the pending question; Cancel drops it too", async () => {
  const { desk, telegram } = await setup();
  await desk.handleText("7", "7", S.at50);
  await desk.handleText("7", "7", S.both);
  assert.ok(lastSent(telegram).text.endsWith(LINES.footer), "the new sentence is handled on its own");
  assert.equal(await desk.handleCallback("7", "7", "sq:7:0"), LINES.questionGone);
  await desk.handleText("7", "7", S.at50);
  const asked = telegram.sent.length;
  assert.equal(await desk.handleCallback("7", "7", "sq:7:x", asked), undefined);
  assert.equal(lastSent(telegram).text, LINES.cancelled);
  assert.equal(await desk.handleCallback("7", "7", "sq:7:0"), LINES.questionGone);
});

test("US2 scenario 4: an answer that still leaves the sentence unread gets the example line, not a second question", async () => {
  const { desk, telegram, translator } = await setup();
  await desk.handleText("7", "7", S.some);
  assert.equal(lastSent(telegram).text, "how much ETH into PEPE?");
  assert.deepEqual(labels(telegram), ["0.005 ETH", "0.01 ETH", "0.05 ETH", "Cancel"]);
  await desk.handleCallback("7", "7", "sq:7:1");
  assert.equal(lastSent(telegram).text, LINES.unread);
  assert.equal(LINES.unread, "I did not get that. Try: sell half my PEPE if it drops 20%.");
  assert.equal(translator.calls.length, 1, "the answer consults no model");
});

test("US2 scenario 5: a message that is not an instruction gets the hint, no question, no card", async () => {
  const { desk, telegram, hints, store } = await setup();
  for (const said of ["gm", "is pepe good", "thanks"]) await desk.handleText("7", "7", said);
  assert.deepEqual(hints, ["7", "7", "7"]);
  assert.equal(telegram.sent.length, 0);
  assert.equal(await store.consumePending("7", clock), undefined);
});

test("FR-012a: a DCA with no interval asks hourly, daily or weekly; a tap after the lease finds the question expired", async () => {
  const { desk, telegram, later } = await setup();
  await desk.handleText("7", "7", S.noEvery);
  assert.equal(lastSent(telegram).text, "how often?");
  assert.deepEqual(labels(telegram), ["hourly", "daily", "weekly", "Cancel"]);
  await desk.handleCallback("7", "7", "sq:7:2");
  assert.match(lastSent(telegram).text, /🔁 dca <code>0\.005 ETH<\/code> of <b>PEPE<\/b> every 168 hours, 4 left/);
  await desk.handleText("7", "7", S.noEvery);
  later(10 * 60_000);
  assert.equal(await desk.handleCallback("7", "7", "sq:7:0"), LINES.questionGone);
});

const putExit = async (build: OrderBuildDeps, orders: MemoryOrderStore, kind: "tp" | "sl", move: number) => {
  const b = await buildExit(build, { tgId: "7", account: ACCOUNT, token: PEPE, kind, move, pct: 100 }, { again: "", buttons: [] });
  assert.ok(b.ok); await orders.put(b.order); return b.order;
};

test("US3 scenarios 1 and 2: a sell of a token not held is refused with the fact; 150% is clamped and said", async () => {
  const { desk, telegram } = await setup();
  await desk.handleText("7", "7", S.doge);
  assert.equal(lastSent(telegram).text, "you hold no DOGE in this account.");
  await desk.handleText("7", "7", S.over);
  assert.match(lastSent(telegram).text, /sell <code>100%<\/code>/); assert.ok(lastSent(telegram).text.includes(LINES.clamped));
});

test("US3 scenario 3: an open take profit is named and offers Replace, Add both, Cancel; Replace closes it, Add both keeps it; another kind sits beside", async () => {
  const { desk, telegram, orders, build } = await setup();
  const old = await putExit(build, orders, "tp", 50);
  await desk.handleText("7", "7", S.tp3x);
  assert.match(lastSent(telegram).text, /<i>open now: 🎯 take profit/);
  assert.deepEqual(labels(telegram), ["Replace", "Add both", "Cancel"]);
  assert.equal(await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:rep`), undefined);
  assert.deepEqual((await open(orders)).map((o) => [o.kind, o.id === old.id]), [["tp", false]], "the old one closed, the new one open");
  await desk.handleText("7", "7", S.tp3x);
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:add`);
  assert.equal((await open(orders)).filter((o) => o.kind === "tp").length, 2, "Add both keeps both");
  await desk.handleText("7", "7", S.sl20);
  assert.deepEqual(labels(telegram), ["Confirm", "Cancel"], "a stop loss beside take profits is no question");
});

test("US3 scenario 4: a second shield on the token is already on", async () => {
  const { desk, telegram, orders, build } = await setup();
  const b = await buildShield(build, { tgId: "7", account: ACCOUNT, token: PEPE });
  assert.ok(b.ok); await orders.put(b.order);
  await desk.handleText("7", "7", S.shield);
  assert.equal(lastSent(telegram).text, SHIELD_ON);
});

test("US3 scenarios 5 and 6: a 6% move at Confirm re-renders with new levels and places nothing; the next Confirm places at them, once", async () => {
  const { desk, telegram, orders, price } = await setup();
  await desk.handleText("7", "7", S.both);
  const id = cardId(telegram);
  price.pepe = (PER_ETH * 94n) / 100n;
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), LINES.moved);
  const again = lastSent(telegram);
  assert.equal(again.kind, "edit"); assert.ok(again.text.includes(LINES.moved));
  assert.deepEqual(again.keyboard!.flat().map((b) => b.text), ["Confirm", "Cancel"]);
  assert.equal((await open(orders)).length, 0);
  await desk.handleCallback("7", "7", `sc:${id}:ok`);
  assert.deepEqual((await open(orders)).map((o) => o.triggerPerEth), [(price.pepe * 10_000n) / 20_000n, (price.pepe * 10_000n) / 7_000n], "levels from the new price");
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), LINES.already);
  assert.equal((await open(orders)).length, 2);
});

test("US3 scenario 7: a tap after ten minutes is expired and places nothing; the sweep expires old cards in the message and leaves a fresh one", async () => {
  const { desk, telegram, orders, store, later } = await setup();
  await desk.handleText("7", "7", S.both);
  const id = cardId(telegram);
  later(CARD_MS);
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), LINES.expired);
  assert.equal(lastSent(telegram).text, LINES.expired); assert.deepEqual(lastSent(telegram).keyboard, []);
  assert.equal((await open(orders)).length, 0);
  const at = (min: number) => new Date(clock.getTime() + min * 60_000).toISOString();
  const card = (chatId: string, createdAt: string) => ({ chatId, tgId: chatId, sentenceHash: "h", token: PEPE, perEthAtCard: PER_ETH, proposals: [], createdAt });
  for (const [chat, created, msg] of [["8", at(0), 41], ["9", at(1), 42], ["10", at(14), 43]] as const) { const c = await store.createCard(card(chat, created)); await store.setMessage(c!.id, msg); }
  const sent = telegram.sent.length;
  assert.equal(await sweepCards(store, telegram, new Date(at(15))), 2);
  assert.deepEqual(telegram.sent.slice(sent).map((o) => (o as Sent).messageId), [41, 42]);
  assert.equal((await store.proposedIn("10"))?.chatId, "10");
});

test("US3 scenarios 8 and 9: a paused session takes the orders and says they wait; an expired session or no account gets Connect", async () => {
  const { desk, telegram, orders, st, connects, links } = await setup();
  st.paused = true;
  await desk.handleText("7", "7", S.both);
  assert.ok(lastSent(telegram).text.endsWith(LINES.waits));
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:ok`);
  assert.equal((await open(orders)).length, 2, "placed although the session would refuse a trade now");
  assert.match(lastSent(telegram).text, /placed\. manage in Positions\.\nwill wait until you resume\.$/);
  st.paused = false; st.expiry = Math.floor(clock.getTime() / 1000) - 1;
  const before = telegram.sent.length;
  await desk.handleText("7", "7", S.both);
  links.links.delete("7");
  await desk.handleText("7", "7", S.both);
  assert.deepEqual(connects, ["7", "7"]); assert.equal(telegram.sent.length, before, "no card");
});

test("US3 scenario 10 and the ceiling: a buy over the per-trade cap is cut to it and says so; a zero cap refuses; ten open orders refuse the card", async () => {
  const { desk, telegram, orders, st } = await setup();
  await desk.handleText("7", "7", S.big);
  assert.match(lastSent(telegram).text, /limit buy <code>0\.05 ETH<\/code>/); assert.ok(lastSent(telegram).text.includes("your session allows 0.05 ETH a trade, so 0.05 ETH"));
  st.maxValuePerCall = "0";
  await desk.handleText("7", "7", S.big);
  assert.equal(lastSent(telegram).text, LINES.noCap);
  for (let i = 0; i < MAX_OPEN_ORDERS - 1; i++) await orders.put({ id: newOrderId(), tgId: "7", account: ACCOUNT, chainId: 4663, token: WIF, kind: "limit", ethWei: 1n, triggerPerEth: 1n, createdAt: clock.toISOString(), status: "open", refusals: 0 });
  await desk.handleText("7", "7", S.both);
  assert.equal(lastSent(telegram).text, CEILING, "nine open and two on the card is past ten");
  noPersona(telegram);
});

test("the ceiling again at Confirm: orders set between card and Confirm count, so the card cannot pass ten; nothing is placed and the card stays", async () => {
  const { desk, telegram, orders } = await setup();
  const put = async (n: number) => { for (let i = 0; i < n; i++) await orders.put({ id: newOrderId(), tgId: "7", account: ACCOUNT, chainId: 4663, token: WIF, kind: "limit", ethWei: 1n, triggerPerEth: 1n, createdAt: clock.toISOString(), status: "open", refusals: 0 }); };
  await put(MAX_OPEN_ORDERS - 3);
  await desk.handleText("7", "7", S.both);
  const id = cardId(telegram);
  await put(2);
  assert.equal(await desk.handleCallback("7", "7", `sc:${id}:ok`), undefined);
  assert.equal(lastSent(telegram).text, CEILING, "nine open now and two on the card");
  assert.equal((await open(orders)).length, MAX_OPEN_ORDERS - 1, "nothing placed");
  const [first] = await open(orders);
  await orders.cancel(first!.id);
  await desk.handleCallback("7", "7", `sc:${id}:ok`);
  assert.equal((await open(orders)).length, MAX_OPEN_ORDERS, "with one closed the same card places");
});

/** A translator whose every answer costs the same: a million input tokens and two million output, $11 at $1 and $5. */
class PricedTranslator implements Translator {
  calls = 0;
  async translate(): Promise<Translation> { this.calls++; return { ok: true, result: { kind: "none" }, usage: { inputTokens: 1_000_000, outputTokens: 2_000_000 } }; }
}

test("US4 scenarios 1 and 6: the twenty-first sentence of the day gets the limit line and no translation; past midnight UTC it is translated", async () => {
  const { desk, telegram, translator, later } = await setup();
  for (let i = 0; i < 20; i++) await desk.handleText("7", "7", `gm ${i}`);
  await desk.handleText("7", "7", S.both);
  assert.equal(lastSent(telegram).text, LINES.limit);
  assert.equal(translator.calls.length, 20);
  later(12 * 3_600_000);
  await desk.handleText("7", "7", S.both);
  assert.equal(translator.calls.length, 21, "a new UTC day starts the count again");
  assert.ok(lastSent(telegram).text.endsWith(LINES.footer));
});

test("US4 scenario 2: one limit for every trader, counted per trader, whatever they hold", async () => {
  const { desk, telegram, translator } = await setup({ limits: { daily: 2 } });
  for (const tg of ["7", "7", "8", "8"]) await desk.handleText(tg, tg, "gm");
  assert.equal(translator.calls.length, 4);
  for (const tg of ["7", "8"]) { await desk.handleText(tg, tg, "gm"); assert.equal(lastSent(telegram).text, LINES.limit); }
});

test("US4 scenario 3: the day's spend passing the alert line tells the operator chat once; the next day can alert again", async () => {
  const translator = new PricedTranslator();
  const { desk, telegram, later, store } = await setup({ translator, limits: { alertUsd: 20, operatorChatId: "ops" } });
  const toOps = () => telegram.sent.filter((o) => o.kind === "send" && o.chatId === "ops");
  await desk.handleText("7", "7", "gm");
  assert.equal(toOps().length, 0, "$11 is under the line");
  await desk.handleText("7", "7", "gm");
  await desk.handleText("7", "7", "gm");
  assert.equal(toOps().length, 1, "the second call crosses the line; the third does not alert again");
  assert.match((toOps()[0] as Sent).text, /passed \$20, \$22\.00 so far/);
  assert.equal(store.spend.get("2026-10-22")?.usdMicros, 33_000_000n);
  later(12 * 3_600_000);
  await desk.handleText("7", "7", "gm"); await desk.handleText("7", "7", "gm");
  assert.equal(toOps().length, 2);
});

test("US4 scenario 4: a translator past its budget gets the FR-021 line in time, places nothing, and costs no count and no spend; the log has the hash only", async () => {
  const slow = new FakeTranslator(MAP, 200, 30);
  const { desk, telegram, orders, store } = await setup({ translator: slow, limits: { daily: 1 } });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  const started = Date.now();
  try { await desk.handleText("7", "7", S.both); } finally { console.warn = warn; }
  assert.ok(Date.now() - started < 1_000);
  assert.equal(lastSent(telegram).text, LINES.failed);
  assert.equal((await open(orders)).length, 0);
  assert.equal(store.counts.get("7:2026-10-22"), 0, "given back");
  assert.equal(store.spend.size, 0);
  assert.equal(warned.length, 1);
  assert.ok(warned[0]!.includes(hashSentence("s", S.both).slice(0, 16)) && warned[0]!.includes("timeout"));
  assert.ok(!warned[0]!.includes("pepe"), "never the words");
  await desk.handleText("7", "7", S.both);
  assert.equal(slow.calls.length, 2, "the failed one did not use the day's one sentence");
});

test("US4 scenario 5: a confirmed card keeps the hash, the held context and the accepted card; no table holds the words", async () => {
  const { desk, telegram, store } = await setup();
  await desk.handleText("7", "7", S.both);
  await desk.handleCallback("7", "7", `sc:${cardId(telegram)}:ok`);
  const [rec] = store.evals;
  assert.equal(rec?.sentenceHash, hashSentence("s", S.both));
  assert.deepEqual(rec?.context, { held: [{ symbol: "PEPE", tail: "00ce" }], perEth: { "00ce": PER_ETH.toString() } });
  assert.deepEqual(rec?.accepted.map((p) => p.kind), ["tp", "sl"]);
  const everything = JSON.stringify({ cards: [...store.cards.values()], pending: [...store.pending.values()], evals: store.evals, counts: [...store.counts] }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!everything.includes("half my pepe"), "the sentence's words are nowhere at rest");
});
