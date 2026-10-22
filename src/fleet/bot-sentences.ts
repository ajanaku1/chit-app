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

export class SentenceDesk {
  readonly #d: SentenceDeskDeps;
  constructor(d: SentenceDeskDeps) { this.#d = d; }

  get #now(): Date { return this.#d.build.now(); }

  async #say(chatId: string, text: string, keyboard: Keyboard = kb([btn("← Back", "home")])): Promise<number | undefined> {
    return (await this.#d.telegram.deliver({ kind: "send", chatId, text, keyboard }))?.messageId;
  }

  /** A sentence from the DM: translated once (FR-023), answered with one card, a line, or the hint. */
  async handleText(chatId: string, tgId: string, text: string): Promise<void> {
    const link = await this.#d.links.getLink(tgId);
    if (!link) return this.#d.connect(chatId, tgId);
    await this.#expireOpen(chatId);
    const candidates = await this.#candidates(link.account);
    const held = candidates.filter((c) => c.balance > 0n);
    const hash = hashSentence(this.#d.secret, text);
    const got = await this.#d.translator.translate({
      sentence: text,
      held: held.map((c) => ({ symbol: c.symbol, tail: tail(c.address) })),
      now: Object.fromEntries(held.map((c) => [tail(c.address), { perEth: c.perEth.toString() }])),
    });
    if (!got.ok) { console.warn(`sentence ${hash.slice(0, 12)}: ${got.failure}`); await this.#say(chatId, LINES.failed); return; }
    if (got.malformed) console.warn(`sentence ${hash.slice(0, 12)}: malformed`);
    const r = got.result;
    if (r.kind === "none") return r.note === "mcap" ? void (await this.#say(chatId, LINES.mcap)) : this.#d.hint(chatId);
    if (r.kind === "question") { await this.#say(chatId, LINES.unread); return; }
    return this.#card(chatId, tgId, hash, r.proposals, r.cut === true, candidates);
  }

  /** A new sentence drops the chat's question and expires its open card, in the message too (FR-009). */
  async #expireOpen(chatId: string): Promise<void> {
    await this.#d.store.dropPending(chatId);
    const open = await this.#d.store.proposedIn(chatId);
    if (!open || !(await this.#d.store.transition(open.id, "expired", this.#now)) || open.messageId === undefined) return;
    await this.#d.telegram.deliver({ kind: "edit", chatId, messageId: open.messageId, text: LINES.expired, keyboard: kb() });
  }

  /** The tokens the account has traded, from the ledger, with the chain's balance and price for each now. */
  async #candidates(account: Address): Promise<Candidate[]> {
    const tokens = [...new Set((await this.#d.positions.forAccount(account)).map((t) => t.token.toLowerCase() as Address))];
    return Promise.all(tokens.map((address) => this.#candidate(address, account)));
  }

  /** The one token every proposal names: a sell among the held, a buy among anything traded (research R3); else the line. */
  #tokenFor(proposals: Proposal[], candidates: Candidate[]): Candidate | string {
    const found = new Set<Candidate>();
    for (const p of proposals) {
      const pool = SELLS.includes(p.kind) ? candidates.filter((c) => c.balance > 0n) : candidates;
      const hits = matchToken(p.tokenText, pool);
      if (hits.length === 0 && SELLS.includes(p.kind)) return `you hold no ${esc(p.tokenText.replace(/^\$/, "").toUpperCase())} in this account.`;
      if (hits.length !== 1) return LINES.unread;
      found.add(pool.find((c) => c.address === hits[0])!);
    }
    return found.size === 1 ? [...found][0]! : LINES.unread;
  }

  async #card(chatId: string, tgId: string, hash: string, proposals: Proposal[], cut: boolean, candidates: Candidate[]): Promise<void> {
    const c = this.#tokenFor(proposals, candidates);
    if (typeof c === "string") { await this.#say(chatId, c); return; }
    if (!c.hasPool) { await this.#say(chatId, "no ETH pool on the venue for this token, so nothing to order."); return; }
    const stored: StoredProposal[] = [];
    for (const p of proposals) {
      const s = toStored(p, c);
      if (typeof s === "string") { await this.#say(chatId, s); return; }
      stored.push(s);
    }
    const card = await this.#d.store.createCard({ chatId, tgId, sentenceHash: hash, token: c.address, perEthAtCard: c.perEth, proposals: stored, createdAt: this.#now.toISOString() });
    if (!card) { await this.#say(chatId, LINES.unread); return; }
    const messageId = await this.#say(chatId, cardText(card, c, cut), kb([btn("Confirm", `sc:${card.id}:ok`), btn("Cancel", `sc:${card.id}:no`)]));
    if (messageId !== undefined) await this.#d.store.setMessage(card.id, messageId);
  }

  /** `sc:<id>:ok` or `sc:<id>:no`, once per card (FR-006); what comes back is the tap's toast. */
  async handleCallback(chatId: string, tgId: string, data: string): Promise<string | undefined> {
    const [, id = "", verb] = data.split(":");
    const card = await this.#d.store.getCard(id);
    if (!card || card.tgId !== tgId || card.chatId !== chatId) return LINES.expired;
    if (verb === "no") return this.#cancel(card);
    if (verb === "ok") return this.#confirm(card);
    return undefined;
  }

  /** The answer to a tap on a card that has already left Proposed. */
  async #byState(id: string): Promise<string> {
    const state = (await this.#d.store.getCard(id))?.state;
    return state === "placed" ? LINES.already : state === "cancelled" ? LINES.cancelled : LINES.expired;
  }

  async #edit(card: SentenceCard, text: string): Promise<void> {
    if (card.messageId !== undefined) await this.#d.telegram.deliver({ kind: "edit", chatId: card.chatId, messageId: card.messageId, text, keyboard: kb() });
  }

  async #cancel(card: SentenceCard): Promise<string | undefined> {
    if (!(await this.#d.store.transition(card.id, "cancelled", this.#now))) return this.#byState(card.id);
    await this.#edit(card, LINES.cancelled);
    return undefined;
  }

  /**
   * Every order is built through the buttons' preflight before the card moves, so a refusal places nothing and
   * leaves the card to tap again; the move to placed is the one atomic step, and only its winner stores the orders.
   */
  async #confirm(card: SentenceCard): Promise<string | undefined> {
    if (card.state !== "proposed") return this.#byState(card.id);
    const link = await this.#d.links.getLink(card.tgId);
    if (!link) { await this.#d.connect(card.chatId, card.tgId); return undefined; }
    const c = await this.#candidate(card.token as Address, link.account);
    const built = await this.#buildAll(card, link.account, c.decimals);
    if (!Array.isArray(built)) { await this.#say(card.chatId, built.reason, built.buttons); return undefined; }
    if (!(await this.#d.store.transition(card.id, "placed", this.#now))) return this.#byState(card.id);
    for (const order of built) await this.#d.build.orders.put(order);
    await this.#d.store.addEval({ sentenceHash: card.sentenceHash, context: { held: [{ symbol: c.symbol, tail: tail(card.token) }], perEth: { [tail(card.token)]: card.perEthAtCard.toString() } }, accepted: card.proposals, at: this.#now.toISOString() });
    await this.#edit(card, cardText(card, c, false, LINES.placed));
    return undefined;
  }

  async #candidate(address: Address, account: Address): Promise<Candidate> {
    const [info, balance] = await Promise.all([this.#d.build.reads.tokenInfo(address), this.#d.build.reads.tokenBalance(address, account)]);
    return { symbol: info.symbol, address, decimals: info.decimals, balance, perEth: info.perEth, hasPool: info.hasPool };
  }

  /** Each proposal through the shared preflight, levels as fixed on the card (FR-014); the first refusal stops it. */
  async #buildAll(card: SentenceCard, account: Address, decimals: number): Promise<Order[] | Refusal> {
    const who = { tgId: card.tgId, account, token: card.token as Address };
    const orders: Order[] = [];
    for (const p of card.proposals) {
      const ethWei = BigInt(p.ethWei ?? "0");
      let b: Built;
      if (p.kind === "tp" || p.kind === "sl") b = await buildExit(this.#d.build, { ...who, kind: p.kind, move: (p.moveBps ?? 0) / 100, pct: p.sizePct ?? 0 }, RETRY);
      else if (p.kind === "limit") b = await buildBuy(this.#d.build, { ...who, kind: "limit", ethWei, perEth: fmt(BigInt(p.levelPerEth), decimals, decimals) }, RETRY);
      else if (p.kind === "dca") b = await buildBuy(this.#d.build, { ...who, kind: "dca", ethWei, hours: (p.everyMs ?? 0) / 3_600_000, times: p.count ?? 0 }, RETRY);
      else b = await buildShield(this.#d.build, who);
      if (!b.ok) return b;
      orders.push(p.kind === "tp" || p.kind === "sl" ? { ...b.order, triggerPerEth: BigInt(p.levelPerEth) } : b.order);
    }
    return orders;
  }
}
