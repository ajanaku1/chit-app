/**
 * The sentence desk (specs/006-agent-sentences): a plain message in the DM is
 * translated once into at most three orders of the kinds the bot already
 * runs, shown as one Proposed card, and placed on Confirm through the same
 * preflight the card buttons use (bot-order-build.ts). The words are never
 * kept: the card and the log carry the sentence's keyed hash only.
 *
 * Every level is fixed at card time as tokens per ETH, with the basis-point
 * maths `buildExit` uses, so what the card shows is what the order gets.
 */

import { createHmac } from "node:crypto";
import type { Address } from "viem";
import type { BotLinkStore } from "./bot-link.js";
import { btn, buildBuy, buildExit, buildShield, fmt, kb, orderLine, toUnits, type Built, type OrderBuildDeps, type Refusal, type Retry } from "./bot-order-build.js";
import type { Order } from "./bot-orders.js";
import type { PositionLedger } from "./bot-positions.js";
import type { SentenceCard, SentenceStore, StoredProposal } from "./bot-sentence-store.js";
import { matchToken, type Proposal, type Translator } from "./bot-sentence-translate.js";
import { esc, type Keyboard, type Telegram } from "./bot-telegram.js";

export type SentenceDeskDeps = {
  translator: Translator;
  store: SentenceStore;
  telegram: Telegram;
  links: BotLinkStore;
  positions: PositionLedger;
  build: OrderBuildDeps;
  /** BOT_KEY_SECRET: keys the sentence hash (research R8). */
  secret: string;
  /** The bot's ordinary hint, for a message that is not an instruction (FR-010). */
  hint: (chatId: string) => Promise<void>;
  /** The Connect prompt, for a trader with no linked account (FR-016). */
  connect: (chatId: string, tgId: string) => Promise<void>;
};

export const LINES = {
  footer: "runs from your account under your caps",
  failed: "I could not read that just now, the card still works.",
  unread: "I did not get that. Try: sell half my PEPE if it drops 20%.",
  mcap: "I work in price, not market cap.",
  three: "three at a time: the first three are on this card.",
  expired: "this card expired, nothing placed. send it again.",
  cancelled: "nothing placed.",
  already: "already placed",
  placed: "placed. manage in Positions.",
} as const;

/** HMAC-SHA256 over the lowercased, whitespace-collapsed sentence: a short sentence's plain hash is a dictionary away from its text. */
export const hashSentence = (secret: string, text: string): string =>
  createHmac("sha256", secret).update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");

/** A token the account has traded, read at card time: the chain balance decides whether it is held (FR-012b). */
type Candidate = { symbol: string; address: Address; decimals: number; balance: bigint; perEth: bigint; hasPool: boolean };
const SELLS: readonly string[] = ["tp", "sl", "shield"];
const HOURS = { hourly: 1, daily: 24, weekly: 168 } as const;
const tail = (a: string): string => a.slice(-4);
const NOBODY = "0x0000000000000000000000000000000000000000" as Address;
const B = 10_000n;
/** A refusal at Confirm leaves the card Proposed: the way back is the card itself. */
const RETRY: Retry = { again: "send the sentence again.", buttons: kb([btn("← Back", "home")]) };

/** A small ETH price, said to four significant digits. */
export const ethPrice = (wei: bigint): string => (wei >= 10n ** 18n ? fmt(wei, 18, 4) : fmt(wei, 18, 18).replace(/^(0\.0*[1-9]\d{0,3})\d*$/, "$1"));
/** One token's price in wei from tokens per ETH in its base units. */
const priceWei = (perEth: bigint, decimals: number): bigint => (perEth > 0n ? 10n ** BigInt(18 + decimals) / perEth : 0n);

/** The move from now, in percent, a level names; undefined is no level the kind can use. */
const moveOf = (p: Proposal, c: Candidate): number | undefined => {
  const l = p.level;
  if (!l) return undefined;
  if ("percent" in l) return Math.abs(l.percent);
  if ("multiple" in l) return p.kind === "tp" ? (l.multiple - 1) * 100 : (1 - l.multiple) * 100;
  const at = toUnits(l.eth, 18), now = priceWei(c.perEth, c.decimals);
  if (!at || !now) return undefined;
  const ratio = Number((at * B) / now) / 100;
  return p.kind === "tp" ? ratio - 100 : 100 - ratio;
};

/** A sell's share, clamped to 100 with the clamp said (FR-012). */
const share = (p: Proposal): { sizePct: number; note?: string } | undefined => {
  if (!p.size || !("pct" in p.size) || p.size.pct <= 0) return undefined;
  return p.size.pct > 100 ? { sizePct: 100, note: "more than all of it is all of it: 100%" } : { sizePct: Math.round(p.size.pct) };
};

const exitOf = (p: Proposal, c: Candidate): StoredProposal | string => {
  const size = share(p), move = moveOf(p, c);
  if (!size || move === undefined) return LINES.unread;
  const tp = p.kind === "tp";
  if (tp ? move < 1 || move > 10_000 : move < 1 || move > 95) return tp ? "the move up must be between 1% and 10000%." : "the move down must be between 1% and 95%.";
  const moveBps = Math.round(move * 100), b = BigInt(moveBps);
  const level = tp ? (c.perEth * B) / (B + b) : (c.perEth * B) / (B - b);
  return { kind: p.kind as "tp" | "sl", sizePct: size.sizePct, moveBps, levelPerEth: level.toString(), ...(size.note ? { note: size.note } : {}) };
};

const buyOf = (p: Proposal, c: Candidate): StoredProposal | string => {
  const ethWei = p.size && "eth" in p.size ? toUnits(p.size.eth, 18) : null;
  if (!ethWei) return LINES.unread;
  if (p.kind === "dca") {
    if (!p.every || !p.count) return LINES.unread;
    return { kind: "dca", ethWei: ethWei.toString(), everyMs: HOURS[p.every] * 3_600_000, count: p.count, levelPerEth: "0" };
  }
  const l = p.level;
  if (l && "eth" in l) {
    const at = toUnits(l.eth, 18);
    return at ? { kind: "limit", ethWei: ethWei.toString(), levelPerEth: (10n ** BigInt(18 + c.decimals) / at).toString() } : LINES.unread;
  }
  const move = l ? ("percent" in l ? Math.abs(l.percent) : (1 - l.multiple) * 100) : undefined;
  if (move === undefined || move < 1 || move > 95) return LINES.unread;
  const moveBps = Math.round(move * 100);
  return { kind: "limit", ethWei: ethWei.toString(), moveBps, levelPerEth: ((c.perEth * B) / (B - BigInt(moveBps))).toString() };
};

/** A proposal as the card stores it, or the line that says why not. */
export const toStored = (p: Proposal, c: Candidate): StoredProposal | string => {
  if (p.kind === "shield") return { kind: "shield", levelPerEth: "0" };
  const out = p.kind === "tp" || p.kind === "sl" ? exitOf(p, c) : buyOf(p, c);
  return typeof out === "string" || !p.note || out.note ? out : { ...out, note: p.note };
};

/** The order a stored proposal becomes, for its line: the same `orderLine` a tapped order is listed with. */
const preview = (card: SentenceCard, p: StoredProposal): Order => ({
  id: "", tgId: card.tgId, account: NOBODY, chainId: 0, token: card.token as Address, kind: p.kind,
  ethWei: BigInt(p.ethWei ?? "0"), createdAt: card.createdAt, status: "open", refusals: 0,
  ...(p.kind === "tp" || p.kind === "sl" || p.kind === "limit" ? { triggerPerEth: BigInt(p.levelPerEth) } : {}),
  ...(p.sizePct !== undefined ? { sellPct: p.sizePct } : {}),
  ...(p.kind === "dca" ? { everyMs: p.everyMs ?? 0, remaining: p.count ?? 0, nextAt: card.createdAt } : {}),
});

/** A level as a multiple of the price now, a percent, and an ETH price. */
const levelWords = (card: SentenceCard, p: StoredProposal, decimals: number): string => {
  const level = BigInt(p.levelPerEth);
  if (level === 0n) return "";
  const multiple = Number((card.perEthAtCard * B) / level) / 10_000;
  const pct = Math.round((multiple - 1) * 1000) / 10;
  return ` · <code>${multiple.toFixed(2)}×</code> · <code>${pct > 0 ? "+" : ""}${pct}%</code> · <code>${ethPrice(priceWei(level, decimals))} ETH</code>`;
};

export const cardText = (card: SentenceCard, c: Candidate, cut: boolean, tailLine: string = LINES.footer): string => [
  `<b>${esc(c.symbol)}</b> · you hold <code>${fmt(c.balance, c.decimals, 2)}</code> · now <code>${ethPrice(priceWei(card.perEthAtCard, c.decimals))} ETH</code>`,
  "",
  ...card.proposals.flatMap((p, i) => [`${i + 1}. ${orderLine(preview(card, p), c.symbol, c.decimals)}${levelWords(card, p, c.decimals)}`, ...(p.note ? [`   <i>${esc(p.note)}</i>`] : [])]),
  ...(cut ? ["", LINES.three] : []),
  "",
  tailLine,
].join("\n");

