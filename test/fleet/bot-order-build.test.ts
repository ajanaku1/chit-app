/**
 * The order preflight the card buttons and the sentence desk share
 * (bot-order-build.ts, specs/006 FR-004): every refusal is one of the
 * owner's own facts in the bot's words with a way back, every pass is an
 * Order the cron already knows how to fire. The fakes are the session
 * test's, so a refusal here is the refusal the button shows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, parseEther } from "viem";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { buildBuy, buildExit, buildShield, orderLine, type OrderBuildDeps, type Retry } from "../../src/fleet/bot-order-build.js";
import { MAX_OPEN_ORDERS, MemoryOrderStore, newOrderId, type Order } from "../../src/fleet/bot-orders.js";
import { sellPreflight, type SessionChain } from "../../src/fleet/bot-session-chain.js";

const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const NOPE = "0x00000000000000000000000000000000000000cf" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const clock = new Date("2026-09-20T12:00:00Z");
const retry: Retry = { again: "tap again to retry.", buttons: [[{ text: "again", callback_data: "again" }]] };

const setup = (p: { held?: bigint; sell?: boolean; refuse?: string; permit2?: boolean; quote?: boolean } = {}) => {
  const reads = {
    chainId: 4663, router: ROUTER,
    async tokenInfo(token: Address) { return { address: token, symbol: token === PEPE ? "PEPE" : "NOPE", decimals: 6, hasPool: token === PEPE, perEth: 1_000_000_000_000n, poolEth: parseEther("5"), hooked: false, fee: 3000, poolOnRecord: token === PEPE }; },
    async tokenBalance() { return p.held ?? 42_000_000n; },
    async quoteSell(token: Address, tokensIn: bigint) { return token === PEPE && p.quote !== false ? (tokensIn * 10n ** 18n) / 1_000_000_000_000n : null; },
  } as unknown as BotChain;
  const session = {
    chainId: 4663,
    async canExecute(_a: Address, _t: Address, _s: string, value: bigint) { if (p.refuse) return { ok: false, why: p.refuse }; if (value > parseEther("0.05")) return { ok: false, why: "over your per-trade cap" }; return { ok: true, why: "" }; },
    async sellAllowed() { return p.sell ?? true; },
    async canSell(_a: Address, _r: Address, poolKey: { currency1?: Address } | undefined, _in: bigint, minOut: bigint) {
      const early = sellPreflight(poolKey?.currency1 ?? PEPE, poolKey as never, minOut);
      if (early) return { ok: false, why: early };
      return p.refuse ? { ok: false, why: p.refuse } : { ok: true, why: "" };
    },
    ...(p.permit2 !== undefined ? { async permit2Fixed() { return p.permit2!; } } : {}),
  } as unknown as SessionChain;
  const orders = new MemoryOrderStore();
  const d: OrderBuildDeps = { reads, session, orders, siteUrl: "https://chit.tools", sellSlippageBps: 300, now: () => clock };
  return { d, orders };
};
const who = { tgId: "7", account: ACCOUNT, token: PEPE };
const fill = async (orders: MemoryOrderStore, n = MAX_OPEN_ORDERS) => { for (let i = 0; i < n; i++) await orders.put({ id: newOrderId(), tgId: "7", account: ACCOUNT, chainId: 4663, token: NOPE, kind: "limit", ethWei: 1n, triggerPerEth: 1n, createdAt: clock.toISOString(), status: "open", refusals: 0 }); };
const refused = (r: Awaited<ReturnType<typeof buildBuy>>, re: RegExp) => { assert.equal(r.ok, false); if (!r.ok) { assert.match(r.reason, re); assert.ok(r.buttons.flat().length > 0, "a refusal offers a way back"); } };
const passed = (r: Awaited<ReturnType<typeof buildBuy>>): Order => { assert.equal(r.ok, true, r.ok ? "" : r.reason); return r.ok ? r.order : (undefined as never); };

test("buy: the amount, the ceiling, the pool and the session's answer are refused in order; a limit and a dca pass as the orders the cron fires", async () => {
  const { d, orders } = setup();
  refused(await buildBuy(d, { ...who, kind: "limit", ethWei: 0n, perEth: "1200000" }, retry), /above zero, like 0.02. tap again/);
  refused(await buildBuy(d, { ...who, token: NOPE, kind: "limit", ethWei: parseEther("0.02"), perEth: "1" }, retry), /no ETH pool on the venue for this token, so nothing to order/);
  refused(await buildBuy(d, { ...who, kind: "limit", ethWei: parseEther("0.2"), perEth: "1" }, retry), /says no to a buy of that size: <b>over your per-trade cap<\/b>/);
  refused(await buildBuy(d, { ...who, kind: "limit", ethWei: parseEther("0.02"), perEth: "0" }, retry), /price must be a number of PEPE per ETH above zero/);
  refused(await buildBuy(d, { ...who, kind: "dca", ethWei: parseEther("0.02"), hours: 0, times: 3 }, retry), /between 1 and 720 hours/);
  refused(await buildBuy(d, { ...who, kind: "dca", ethWei: parseEther("0.02"), hours: 4, times: 101 }, retry), /between 1 and 100 buys/);
  const limit = passed(await buildBuy(d, { ...who, kind: "limit", ethWei: parseEther("0.02"), perEth: "1200000" }, retry));
  assert.equal(limit.kind, "limit"); assert.equal(limit.triggerPerEth, 1_200_000_000_000n, "the level in the token's six decimals"); assert.equal(limit.chainId, 4663); assert.equal(limit.status, "open");
  const dca = passed(await buildBuy(d, { ...who, kind: "dca", ethWei: parseEther("0.01"), hours: 4, times: 6 }, retry));
  assert.equal(dca.kind, "dca"); assert.equal(dca.everyMs, 4 * 3_600_000); assert.equal(dca.remaining, 6); assert.equal(dca.nextAt, clock.toISOString());
  assert.equal((await orders.openFor("7", 4663)).length, 0, "the builder stores nothing; put is the caller's");
  await fill(orders);
  refused(await buildBuy(d, { ...who, kind: "limit", ethWei: parseEther("0.02"), perEth: "1200000" }, retry), new RegExp(`that is ${MAX_OPEN_ORDERS} open orders`));
});

test("exit: the level, the share, the ceiling, the pool, the position, the flag, permit2, the quote and canSell are each a refusal; a pass fixes the level in basis points", async () => {
  const { d, orders } = setup();
  refused(await buildExit(d, { ...who, kind: "tp", move: 0, pct: 100 }, retry), /move up must be between 1% and 10000%/);
  refused(await buildExit(d, { ...who, kind: "sl", move: 96, pct: 100 }, retry), /move down must be between 1% and 95%/);
  refused(await buildExit(d, { ...who, kind: "tp", move: 50, pct: 0 }, retry), /whole percent of what you hold, 1 to 100/);
  refused(await buildExit(d, { ...who, token: NOPE, kind: "tp", move: 50, pct: 100 }, retry), /nothing to order/);
  refused(await buildExit(setup({ held: 0n }).d, { ...who, kind: "sl", move: 20, pct: 100 }, retry), /holds no PEPE, so there is nothing to protect yet/);
  refused(await buildExit(setup({ sell: false }).d, { ...who, kind: "tp", move: 50, pct: 100 }, retry), /a take profit sells from your account, and your session does not allow sells yet/);
  refused(await buildExit(setup({ permit2: true }).d, { ...who, kind: "tp", move: 50, pct: 100 }, retry), /can't be sold through the session/);
  refused(await buildExit(setup({ quote: false }).d, { ...who, kind: "tp", move: 50, pct: 100 }, retry), /^no ETH pool on the venue for this token\.$/);
  refused(await buildExit(setup({ refuse: "paused" }).d, { ...who, kind: "tp", move: 50, pct: 100 }, retry), /says no to a sale of that share: <b>paused<\/b>/);
  const tp = passed(await buildExit(d, { ...who, kind: "tp", move: 50, pct: 100 }, retry));
  assert.equal(tp.triggerPerEth, (1_000_000_000_000n * 10_000n) / 15_000n, "+50% is two thirds the tokens per ETH"); assert.equal(tp.sellPct, 100); assert.equal(tp.ethWei, 0n);
  const sl = passed(await buildExit(d, { ...who, kind: "sl", move: 2.5, pct: 40 }, retry));
  assert.equal(sl.triggerPerEth, (1_000_000_000_000n * 10_000n) / 9_750n, "-2.5% is exact in basis points"); assert.equal(sl.sellPct, 40);
  assert.match(orderLine(sl, "PEPE", 6), /🛑 stop loss: sell <code>40%<\/code> of your <b>PEPE<\/b>/);
  await fill(orders);
  refused(await buildExit(d, { ...who, kind: "tp", move: 50, pct: 100 }, retry), new RegExp(`that is ${MAX_OPEN_ORDERS} open orders`));
});

test("shield: one per token, the ceiling, the pool, the position, the flag, permit2, the quote and canSell at the shield's floor; a pass is all of the position", async () => {
  const { d, orders } = setup();
  refused(await buildShield(d, { ...who, token: NOPE }), /nothing to shield/);
  refused(await buildShield(setup({ held: 0n }).d, who), /holds no PEPE, so there is nothing to shield yet/);
  refused(await buildShield(setup({ sell: false }).d, who), /a rug shield sells from your account, and your session does not allow sells yet/);
  refused(await buildShield(setup({ permit2: true }).d, who), /can't be sold through the session/);
  refused(await buildShield(setup({ quote: false }).d, who), /^no ETH pool on the venue for this token\.$/);
  refused(await buildShield(setup({ refuse: "paused" }).d, who), /says no to selling this position: <b>paused<\/b>/);
  const shield = passed(await buildShield(d, who));
  assert.equal(shield.kind, "shield"); assert.equal(shield.sellPct, 100); assert.equal(shield.ethWei, 0n); assert.equal(shield.triggerPerEth, undefined);
  assert.match(orderLine(shield, "PEPE", 6), /🛡 rug shield: sell all your <b>PEPE<\/b>/);
  await orders.put(shield);
  refused(await buildShield(d, who), /already on for this token/);
  await fill(orders, MAX_OPEN_ORDERS - 1);
  refused(await buildShield(d, { ...who, token: NOPE }), new RegExp(`that is ${MAX_OPEN_ORDERS} open orders`));
});
