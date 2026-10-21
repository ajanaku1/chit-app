/**
 * The order preflight and construction shared by the card buttons and the
 * sentence desk (specs/006-agent-sentences, FR-004): one path, one set of
 * reads, one set of refusal words. Nothing here stores or sends; a built
 * order goes to `OrderStore.put` by the caller, and a refusal carries the
 * words and buttons the caller shows.
 *
 * Everything the owner controls is checked before anything is built: the
 * open-order ceiling, a pool, a position, the let it sell flag, a token the
 * session can sell (`permit2Fixed`), and the contract's own answer for this
 * trade now (`canExecute`, `canSell`), so an order that could never fire is
 * refused here in words, not three times from the cron.
 */
import type { Address } from "viem";
import type { BotChain } from "./bot-chain.js";
import { MAX_OPEN_ORDERS, SHIELD_SLIPPAGE_BPS, newOrderId, type Order, type OrderStore } from "./bot-orders.js";
import type { SessionChain } from "./bot-session-chain.js";
import { esc, type Keyboard } from "./bot-telegram.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, minOutFor, venuePoolKey } from "./v4-swap.js";

export type OrderBuildDeps = { reads: BotChain; session: SessionChain; orders: OrderStore; siteUrl: string; sellSlippageBps: number; now: () => Date };
export type Refusal = { ok: false; reason: string; buttons: Keyboard };
export type Built = { ok: true; order: Order; line: string } | Refusal;
/** The prompt's own way back after a value is refused: the words and the button that reopens it. */
export type Retry = { again: string; buttons: Keyboard };
type Who = { tgId: string; account: Address; token: Address };
export type BuyAsk = Who & ({ kind: "limit"; ethWei: bigint; perEth: string } | { kind: "dca"; ethWei: bigint; hours: number; times: number });
export type ExitAsk = Who & { kind: "tp" | "sl"; move: number; pct: number };

export const kb = (...rows: Keyboard): Keyboard => rows;
export const btn = (text: string, data: string) => ({ text, callback_data: data });
export const url = (text: string, href: string) => ({ text, url: href });
export const fmt = (units: bigint, decimals = 18, places = 5): string => {
  const neg = units < 0n; const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals); const whole = u / base; const frac = u % base;
  const f = frac.toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${f ? "." + f : ""}`;
};
export const eth = (wei: bigint, places = 5): string => fmt(wei, 18, places);
export const toUnits = (s: string, decimals: number): bigint | null => {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
};

/**
 * A token that fixes Permit2's allowance at infinity (Solady-style) refuses the exact approval `sell` makes and its reset
 * to zero, so the session account can never sell it (2026-10-07, CHOP). The card says so before a buy, the Sell tap says
 * so instead of sending a sale that reverts, and both name the way out: withdrawToken from the Sessions page.
 */
export const permit2FixedCard = (symbol: string, sessionsUrl: string): string =>
  `⚠️ <b>the bot can buy ${esc(symbol)} but can't sell it from your session.</b> this is a Clanker-style launch: the token fixes its Permit2 approval at infinity, which the session's sell can't work with. if you buy, the only way out is <a href="${sessionsUrl}#wtoken-form">Withdraw token to my wallet</a> on the Sessions page, then selling from your wallet. only you can do that; the bot cannot move tokens to your wallet.`;

export const permit2FixedSale = (symbol: string): string =>
  `${esc(symbol)} can't be sold through the session: it is a Clanker-style launch that fixes its Permit2 approval at infinity, and the account's sell sets an exact one, so the token refuses it every time. nothing was sent and no gas was spent.\n\nyour ${esc(symbol)} is still in your account and only you can move it: tap the button below, use Withdraw token to my wallet, then sell it from your wallet.`;

export const orderLine = (o: Order, symbol: string, decimals: number): string => {
  if (o.kind === "shield") return `🛡 rug shield: sell all your <b>${esc(symbol)}</b> if its liquidity is pulled or its dev sells`;
  if (o.kind === "tp") return `🎯 take profit: sell <code>${o.sellPct ?? 100}%</code> of your <b>${esc(symbol)}</b> once one ETH buys <code>${fmt(o.triggerPerEth ?? 0n, decimals, 2)} ${esc(symbol)}</code> or fewer`;
  if (o.kind === "sl") return `🛑 stop loss: sell <code>${o.sellPct ?? 100}%</code> of your <b>${esc(symbol)}</b> once one ETH buys <code>${fmt(o.triggerPerEth ?? 0n, decimals, 2)} ${esc(symbol)}</code> or more`;
  if (o.kind === "limit") return `⏱ limit buy <code>${eth(o.ethWei)} ETH</code> of <b>${esc(symbol)}</b> at <code>${fmt(o.triggerPerEth ?? 0n, decimals, 2)} ${esc(symbol)}</code> per ETH or better`;
  const every = (o.everyMs ?? 0) / 3_600_000;
  return `🔁 dca <code>${eth(o.ethWei)} ETH</code> of <b>${esc(symbol)}</b> every ${every} hour${every === 1 ? "" : "s"}, ${o.remaining ?? 0} left, next ${(o.nextAt ?? "").slice(0, 16).replace("T", " ")} UTC`;
};

const no = (reason: string, buttons: Keyboard): Refusal => ({ ok: false, reason, buttons });
const backTo = (token: Address) => btn("← Back", `token:${token}`);
const ceiling = (token: Address): Refusal => no(`that is ${MAX_OPEN_ORDERS} open orders, the most one account keeps in the beta; cancel one from 📋 Orders to set another.`, kb([btn("📋 Orders", "orders"), backTo(token)]));
const noPool = (what: string): Refusal => no(`no ETH pool on the venue for this token, so nothing to ${what}.`, kb([btn("← Back", "home")]));

/** A limit buy or a DCA: the amount was parsed by the prompt; the level is read in the token's own decimals. */
export const buildBuy = async (d: OrderBuildDeps, ask: BuyAsk, retry: Retry): Promise<Built> => {
  const { tgId, account, token } = ask;
  if (ask.ethWei <= 0n) return no(`the amount must be a number of ETH above zero, like 0.02. ${retry.again}`, retry.buttons);
  if ((await d.orders.openFor(tgId, d.session.chainId)).length >= MAX_OPEN_ORDERS) return ceiling(token);
  const info = await d.reads.tokenInfo(token);
  if (!info.hasPool) return noPool("order");
  const can = await d.session.canExecute(account, d.reads.router, UNIVERSAL_ROUTER_EXECUTE_SELECTOR, ask.ethWei);
  if (!can.ok) return no(`your session says no to a buy of that size: <b>${esc(can.why)}</b>. manage it on the Sessions page, then set the order.`, kb([url("🔑 Sessions page", `${d.siteUrl}/app/sessions`), backTo(token)]));
  const now = d.now().toISOString();
  const base = { id: newOrderId(), tgId, account, chainId: d.session.chainId, token, ethWei: ask.ethWei, createdAt: now, status: "open" as const, refusals: 0 };
  let order: Order;
  if (ask.kind === "limit") {
    const trigger = toUnits(ask.perEth, info.decimals);
    if (trigger === null || trigger <= 0n) return no(`the price must be a number of ${esc(info.symbol)} per ETH above zero, like 1200000. ${retry.again}`, retry.buttons);
    order = { ...base, kind: "limit", triggerPerEth: trigger };
  } else {
    if (ask.hours < 1 || ask.hours > 720) return no(`the interval must be between 1 and 720 hours. ${retry.again}`, retry.buttons);
    if (ask.times < 1 || ask.times > 100) return no(`the count must be between 1 and 100 buys. ${retry.again}`, retry.buttons);
    order = { ...base, kind: "dca", everyMs: ask.hours * 3_600_000, remaining: ask.times, nextAt: now };
  }
  return { ok: true, order, line: orderLine(order, info.symbol, info.decimals) };
};

/**
 * A take profit or a stop loss: the level is said as a move from the price now (+50%, -20%) and stored as the tokens per
 * ETH the pool shows at that price, the share as a percent of what the account holds when it fires.
 */
export const buildExit = async (d: OrderBuildDeps, ask: ExitAsk, retry: Retry): Promise<Built> => {
  const { tgId, account, token, move, pct } = ask;
  const tp = ask.kind === "tp";
  if (tp ? move < 1 || move > 10_000 : move < 1 || move > 95) return no(`${tp ? "the move up must be between 1% and 10000%" : "the move down must be between 1% and 95%"}. ${retry.again}`, retry.buttons);
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) return no(`the share must be a whole percent of what you hold, 1 to 100. ${retry.again}`, retry.buttons);
  if ((await d.orders.openFor(tgId, d.session.chainId)).length >= MAX_OPEN_ORDERS) return ceiling(token);
  const sessions = `${d.siteUrl}/app/sessions`;
  const [info, held] = await Promise.all([d.reads.tokenInfo(token), d.reads.tokenBalance(token, account)]);
  if (!info.hasPool) return noPool("order");
  const amount = (held * BigInt(pct)) / 100n;
  if (amount === 0n) return no(`your account holds no ${esc(info.symbol)}, so there is nothing to protect yet. buy first, then set it from the card.`, kb([backTo(token)]));
  if (!(await d.session.sellAllowed(account))) return no(`a ${tp ? "take profit" : "stop loss"} sells from your account, and your session does not allow sells yet. on the Sessions page, next to the bot's key, turn on let it sell (one transaction), then set it again.`, kb([url("🔑 Sessions page", sessions), backTo(token)]));
  if (await d.session.permit2Fixed?.(token, account).catch(() => false)) return no(permit2FixedSale(info.symbol), kb([url("🔑 Withdraw token to my wallet", `${sessions}#wtoken-form`), backTo(token)]));
  const quote = await d.reads.quoteSell(token, amount);
  if (quote === null) return no("no ETH pool on the venue for this token.", kb([btn("← Back", "home")]));
  const deadline = BigInt(Math.floor(d.now().getTime() / 1000) + 3600);
  const can = await d.session.canSell(account, d.reads.router, info.poolKey ?? venuePoolKey(token), amount, minOutFor(quote, d.sellSlippageBps), deadline);
  if (!can.ok) return no(`your session says no to a sale of that share: <b>${esc(can.why)}</b>. manage it on the Sessions page, then set the order.`, kb([url("🔑 Sessions page", sessions), backTo(token)]));
  // A price up by `move` percent is that much fewer tokens per ETH; down, that much more. In basis points, so 2.5% is exact.
  const bps = BigInt(Math.round(move * 100));
  const trigger = tp ? (info.perEth * 10_000n) / (10_000n + bps) : (info.perEth * 10_000n) / (10_000n - bps);
  const order: Order = { id: newOrderId(), tgId, account, chainId: d.session.chainId, token, kind: ask.kind, ethWei: 0n, triggerPerEth: trigger, sellPct: pct, createdAt: d.now().toISOString(), status: "open", refusals: 0 };
  return { ok: true, order, line: orderLine(order, info.symbol, info.decimals) };
};

/** A rug shield on a held token: all of the position, no level, one per token. */
export const buildShield = async (d: OrderBuildDeps, ask: Who): Promise<Built> => {
  const { tgId, account, token } = ask;
  const back = backTo(token);
  const open = await d.orders.openFor(tgId, d.session.chainId);
  if (open.some((o) => o.kind === "shield" && o.token.toLowerCase() === token.toLowerCase())) return no("🛡 rug shield is already on for this token. turn it off from 📋 Orders.", kb([btn("📋 Orders", "orders"), back]));
  if (open.length >= MAX_OPEN_ORDERS) return ceiling(token);
  const sessions = `${d.siteUrl}/app/sessions`;
  const [info, held] = await Promise.all([d.reads.tokenInfo(token), d.reads.tokenBalance(token, account)]);
  if (!info.hasPool) return noPool("shield");
  if (held === 0n) return no(`your account holds no ${esc(info.symbol)}, so there is nothing to shield yet.`, kb([back]));
  if (!(await d.session.sellAllowed(account))) return no("a rug shield sells from your account, and your session does not allow sells yet. on the Sessions page, next to the bot's key, turn on let it sell (one transaction), then tap it again.", kb([url("🔑 Sessions page", sessions), back]));
  if (await d.session.permit2Fixed?.(token, account).catch(() => false)) return no(permit2FixedSale(info.symbol), kb([url("🔑 Withdraw token to my wallet", `${sessions}#wtoken-form`), back]));
  const quote = await d.reads.quoteSell(token, held);
  if (quote === null) return no("no ETH pool on the venue for this token.", kb([btn("← Back", "home")]));
  const deadline = BigInt(Math.floor(d.now().getTime() / 1000) + 3600);
  const can = await d.session.canSell(account, d.reads.router, info.poolKey ?? venuePoolKey(token), held, minOutFor(quote, SHIELD_SLIPPAGE_BPS), deadline);
  if (!can.ok) return no(`your session says no to selling this position: <b>${esc(can.why)}</b>. manage it on the Sessions page, then tap it again.`, kb([url("🔑 Sessions page", sessions), back]));
  const order: Order = { id: newOrderId(), tgId, account, chainId: d.session.chainId, token, kind: "shield", ethWei: 0n, sellPct: 100, createdAt: d.now().toISOString(), status: "open", refusals: 0 };
  return { ok: true, order, line: orderLine(order, info.symbol, info.decimals) };
};
