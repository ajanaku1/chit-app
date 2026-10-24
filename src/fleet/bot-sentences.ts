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

import type { Address } from "viem";
import type { BotLinkStore } from "./bot-link.js";
import { CEILING, SHIELD_ON, btn, buildBuy, buildExit, buildShield, eth, fmt, kb, orderLine, toUnits, type Built, type OrderBuildDeps, type Refusal, type Retry } from "./bot-order-build.js";
import { MAX_OPEN_ORDERS, type Order } from "./bot-orders.js";
import type { PositionLedger } from "./bot-positions.js";
import type { SessionChain } from "./bot-session-chain.js";
import { sessionState } from "./session-keys.js";
import { utcDay, type SentenceCard, type SentenceStore, type StoredProposal } from "./bot-sentence-store.js";
import { apply, directionAsk, gap, intervalAsk, sizeAsk, tokenAsk, type Ask, type Draft } from "./bot-sentence-questions.js";
import { hashSentence, matchToken, spendMicros, type Proposal, type TranslationResult, type Translation, type Translator } from "./bot-sentence-translate.js";
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
  /** The day's limits and prices (contracts/env.md); absent fields take the defaults. */
  limits?: Partial<SentenceLimits>;
};

/** One limit for every trader (FR-019), the day's spend that alerts the operator once (FR-020), and the per-million prices. */
export type SentenceLimits = { daily: number; alertUsd: number; priceIn: number; priceOut: number; operatorChatId?: string };
/** Prices are USD per million tokens, Haiku 4.5's list price; BOT_SENTENCE_PRICE_IN and _OUT set the model's real ones. */
export const SENTENCE_DEFAULTS: SentenceLimits = { daily: 20, alertUsd: 20, priceIn: 1, priceOut: 5 };

export const LINES = {
  footer: "runs from your account under your caps",
  failed: "I could not read that just now, the card still works.",
  limit: "that is today's limit for sentences, the card still works.",
  unread: "I did not get that. Try: sell half my PEPE if it drops 20%.",
  mcap: "I work in price, not market cap.",
  three: "three at a time: the first three are on this card.",
  expired: "this card expired, nothing placed. send it again.",
  cancelled: "nothing placed.",
  already: "already placed",
  placed: "placed. manage in Positions.",
  questionGone: "that question expired, send it again.",
  moved: "price moved, check again.",
  waits: "will wait until you resume.",
  clamped: "size clamped to 100%",
  noCap: "your session allows no ETH a trade, so there is nothing to buy with. raise it on the Sessions page.",
} as const;

/** A token the account has traded, read at card time: the chain balance decides whether it is held (FR-012b). */
type Candidate = { symbol: string; address: Address; decimals: number; balance: bigint; perEth: bigint; hasPool: boolean };
const SELLS: readonly string[] = ["tp", "sl", "shield"];
const HOURS = { hourly: 1, daily: 24, weekly: 168 } as const;
const tail = (a: string): string => a.slice(-4);
const NOBODY = "0x0000000000000000000000000000000000000000" as Address;
const B = 10_000n;
/** A question waits this long for its tap (data-model.md bot_sentence_pending). */
const LEASE_MS = 10 * 60_000;
/** A Proposed card is good for this long (FR-005); the orders cron edits it to expired within five minutes after. */
export const CARD_MS = 10 * 60_000;
/** More than this many basis points of move between the card and Confirm re-renders it (FR-014). */
const MOVED_BPS = 500n;
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
  return p.size.pct > 100 ? { sizePct: 100, note: LINES.clamped } : { sizePct: Math.round(p.size.pct) };
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

export const cardText = (card: SentenceCard, c: Candidate, cut: boolean, tailLine: string = LINES.footer, existing?: Order): string => [
  `<b>${esc(c.symbol)}</b> · you hold <code>${fmt(c.balance, c.decimals, 2)}</code> · now <code>${ethPrice(priceWei(card.perEthAtCard, c.decimals))} ETH</code>`,
  "",
  ...(existing ? [`<i>open now: ${orderLine(existing, c.symbol, c.decimals)}</i>`, ""] : []),
  ...card.proposals.flatMap((p, i) => [`${i + 1}. ${orderLine(preview(card, p), c.symbol, c.decimals)}${levelWords(card, p, c.decimals)}`, ...(p.note ? [`   <i>${esc(p.note)}</i>`] : [])]),
  ...(cut ? ["", LINES.three] : []),
  "",
  tailLine,
].join("\n");

/** Confirm and Cancel, or Replace, Add both and Cancel when the card names an open order of the same kind (FR-013). */
const cardKeys = (card: SentenceCard): Keyboard => card.existingOrderId
  ? kb([btn("Replace", `sc:${card.id}:rep`), btn("Add both", `sc:${card.id}:add`), btn("Cancel", `sc:${card.id}:no`)])
  : kb([btn("Confirm", `sc:${card.id}:ok`), btn("Cancel", `sc:${card.id}:no`)]);

/** The same relative instruction at a new price: a move in basis points gives a new level; an ETH level stays (FR-014). */
const reprice = (p: StoredProposal, perEth: bigint): StoredProposal => {
  if (p.moveBps === undefined) return p;
  const b = BigInt(p.moveBps);
  return { ...p, levelPerEth: (p.kind === "tp" ? (perEth * B) / (B + b) : (perEth * B) / (B - b)).toString() };
};

/** Paused, the orders are taken and wait (FR-016): the session's answer for this trade is not asked; every other check is. */
const waiting = (s: SessionChain): SessionChain => ({ ...s, canExecute: async () => ({ ok: true, why: "" }), canSell: async () => ({ ok: true, why: "" }) });

/** A message the desk sent, said again in place; no buttons unless given. A message that was never sent is left alone. */
const editIn = async (telegram: Telegram, chatId: string, messageId: number | undefined, text: string, keyboard: Keyboard = kb()): Promise<void> => {
  if (messageId !== undefined) await telegram.deliver({ kind: "edit", chatId, messageId, text, keyboard });
};

/** The orders cron's sweep (research R5): every Proposed card past its ten minutes becomes expired, in the message too. */
export const sweepCards = async (store: SentenceStore, telegram: Telegram, now: Date): Promise<number> => {
  const stale = await store.expireStale(new Date(now.getTime() - CARD_MS), now);
  for (const c of stale) {
    await editIn(telegram, c.chatId, c.messageId, LINES.expired).catch(() => undefined);
  }
  return stale.length;
};

type Gate = { paused: boolean; capWei: bigint };

export class SentenceDesk {
  readonly #d: SentenceDeskDeps;
  readonly #limits: SentenceLimits;
  constructor(d: SentenceDeskDeps) { this.#d = d; this.#limits = { ...SENTENCE_DEFAULTS, ...d.limits }; }

  get #now(): Date { return this.#d.build.now(); }

  async #say(chatId: string, text: string, keyboard: Keyboard = kb([btn("← Back", "home")])): Promise<number | undefined> {
    return (await this.#d.telegram.deliver({ kind: "send", chatId, text, keyboard }))?.messageId;
  }

  /** A sentence from the DM: translated once (FR-023), answered with one card, a line, or the hint. */
  async handleText(chatId: string, tgId: string, text: string): Promise<void> {
    const link = await this.#d.links.getLink(tgId);
    const gate = link ? await this.#gate(link.account) : undefined;
    if (!link || !gate) return this.#d.connect(chatId, tgId);
    await this.#expireOpen(chatId);
    const candidates = await this.#candidates(link.account);
    const held = candidates.filter((c) => c.balance > 0n);
    const hash = hashSentence(this.#d.secret, text);
    const got = await this.#translate(tgId, hash, {
      sentence: text,
      held: held.map((c) => ({ symbol: c.symbol, tail: tail(c.address) })),
      now: Object.fromEntries(held.map((c) => [tail(c.address), { perEth: c.perEth.toString() }])),
    });
    if (got === "limit") { await this.#say(chatId, LINES.limit); return; }
    if (!got.ok) { await this.#say(chatId, LINES.failed); return; }
    const r = got.result;
    if (r.kind === "none") return r.note === "mcap" ? void (await this.#say(chatId, LINES.mcap)) : this.#d.hint(chatId);
    if (r.kind === "question") return this.#question(chatId, tgId, hash, r, candidates, gate);
    return this.#card(chatId, tgId, hash, { proposals: r.proposals }, candidates, { cut: r.cut === true, asked: false, gate });
  }

  /** The session as the card needs it: paused or not and the per-trade cap; undefined is the Connect prompt (FR-016). */
  async #gate(account: Address): Promise<Gate | undefined> {
    const view = await this.#d.build.session.sessionOf(account);
    const state = sessionState(view, Math.floor(this.#now.getTime() / 1000));
    return state === "active" || state === "paused" ? { paused: state === "paused", capWei: BigInt(view.maxValuePerCall) } : undefined;
  }

  /** The model's own question: the direction is asked from the move it heard; the card path finds and asks the rest. */
  async #question(chatId: string, tgId: string, hash: string, r: Extract<TranslationResult, { kind: "question" }>, candidates: Candidate[], gate: Gate): Promise<void> {
    if (r.draft.length === 0) { await this.#say(chatId, LINES.unread); return; }
    if (r.missing !== "direction") return this.#card(chatId, tgId, hash, { proposals: r.draft }, candidates, { cut: false, asked: false, gate });
    const ask = directionAsk(r.draft);
    if (!ask) { await this.#say(chatId, LINES.unread); return; }
    return this.#ask(chatId, tgId, hash, { proposals: r.draft }, ask);
  }

  /** One question with buttons (FR-007), the draft kept for ten minutes against the tap. */
  async #ask(chatId: string, tgId: string, hash: string, draft: Draft, ask: Ask): Promise<void> {
    const partial = { missing: ask.missing, draft: draft.proposals, choices: ask.choices, labels: ask.labels, ...(draft.pinned ? { pinned: draft.pinned } : {}) };
    await this.#d.store.setPending({ chatId, tgId, sentenceHash: hash, partial, leaseUntil: new Date(this.#now.getTime() + LEASE_MS).toISOString() });
    await this.#say(chatId, ask.text, kb(...ask.labels.map((label, i) => [btn(label, `sq:${chatId}:${i}`)]), [btn("Cancel", `sq:${chatId}:x`)]));
  }

  /**
   * The one model call, counted first (FR-019: past the limit there is no call) and given back if it fails (FR-021);
   * an answer's cost goes on the day, and the day's first pass over the alert line tells the operator (FR-020). The
   * log carries the hash, the class and the time, never the words (FR-022).
   */
  async #translate(tgId: string, hash: string, input: Parameters<Translator["translate"]>[0]): Promise<Translation | "limit"> {
    const day = utcDay(this.#now);
    if (!(await this.#d.store.bump(tgId, day, this.#limits.daily)).ok) return "limit";
    const started = Date.now();
    const got = await this.#d.translator.translate(input);
    const ms = Date.now() - started;
    if (!got.ok) {
      await this.#d.store.unbump(tgId, day);
      console.warn(`desk: ${JSON.stringify({ hash: hash.slice(0, 16), class: got.failure, ms })}`);
      return got;
    }
    if (got.malformed) console.warn(`desk: ${JSON.stringify({ hash: hash.slice(0, 16), class: "malformed", ms })}`);
    await this.#spend(day, spendMicros(got.usage, this.#limits.priceIn, this.#limits.priceOut));
    return got;
  }

  async #spend(day: string, micros: bigint): Promise<void> {
    const total = await this.#d.store.addSpend(day, micros);
    const chat = this.#limits.operatorChatId;
    if (!chat || total < BigInt(Math.round(this.#limits.alertUsd * 1_000_000)) || !(await this.#d.store.claimAlert(day, this.#now))) return;
    await this.#d.telegram.deliver({ kind: "send", chatId: chat, text: `sentence desk: today's translation spend passed $${this.#limits.alertUsd}, $${(Number(total) / 1_000_000).toFixed(2)} so far (${day} UTC). one alert a day.` }).catch(() => undefined);
  }

  /** A new sentence drops the chat's question and expires its open card, in the message too (FR-009). */
  async #expireOpen(chatId: string): Promise<void> {
    await this.#d.store.dropPending(chatId);
    const open = await this.#d.store.proposedIn(chatId);
    if (open && (await this.#d.store.transition(open.id, "expired", this.#now))) await editIn(this.#d.telegram, chatId, open.messageId, LINES.expired);
  }

  /** The tokens the account has traded, from the ledger, with the chain's balance and price for each now. */
  async #candidates(account: Address): Promise<Candidate[]> {
    const tokens = [...new Set((await this.#d.positions.forAccount(account)).map((t) => t.token.toLowerCase() as Address))];
    return Promise.all(tokens.map((address) => this.#candidate(address, account)));
  }

  /**
   * The one token every proposal names: a sell among the held, a buy among anything traded (research R3). More than
   * one match, or a buy or a nameless token that matches nothing, is the token question's options; else the line.
   */
  #tokenFor(draft: Draft, candidates: Candidate[]): Candidate | Candidate[] | string {
    const held = candidates.filter((c) => c.balance > 0n);
    if (draft.pinned) return candidates.find((c) => c.address === draft.pinned) ?? LINES.unread;
    const found = new Set<Candidate>();
    for (const p of draft.proposals) {
      const sell = SELLS.includes(p.kind), pool = sell ? held : candidates;
      const named = matchToken(p.tokenText, pool), hits = pool.filter((c) => named.includes(c.address));
      if (hits.length > 1) return hits;
      if (hits.length === 0 && sell && p.tokenText.trim()) return `you hold no ${esc(p.tokenText.replace(/^\$/, "").toUpperCase())} in this account.`;
      if (hits.length === 0) return held.length ? held : LINES.unread;
      found.add(hits[0]!);
    }
    return found.size === 1 ? [...found][0]! : LINES.unread;
  }

  /** The draft as a card, or the one question it still needs; after a question has been asked, the line instead (FR-008). */
  async #card(chatId: string, tgId: string, hash: string, draft: Draft, candidates: Candidate[], o: { cut: boolean; asked: boolean; gate: Gate }): Promise<void> {
    const c = this.#tokenFor(draft, candidates);
    if (typeof c === "string") { await this.#say(chatId, c); return; }
    if (Array.isArray(c)) return o.asked ? void (await this.#say(chatId, LINES.unread)) : this.#ask(chatId, tgId, hash, draft, tokenAsk(c));
    if (!c.hasPool) { await this.#say(chatId, "no ETH pool on the venue for this token, so nothing to order."); return; }
    const g = gap(draft.proposals);
    if (g) return o.asked ? void (await this.#say(chatId, LINES.unread)) : this.#ask(chatId, tgId, hash, { ...draft, pinned: c.address }, g.missing === "size" ? sizeAsk(g.sell, c.symbol) : intervalAsk());
    const stored: StoredProposal[] = [];
    for (const p of draft.proposals) {
      const s = toStored(p, c);
      if (typeof s === "string") { await this.#say(chatId, s); return; }
      stored.push(s);
    }
    const checked = await this.#check(tgId, c, stored, o.gate);
    if (typeof checked === "string") { await this.#say(chatId, checked); return; }
    const card = await this.#d.store.createCard({ chatId, tgId, sentenceHash: hash, token: c.address, perEthAtCard: c.perEth, proposals: checked.proposals, createdAt: this.#now.toISOString(), ...(checked.existing ? { existingOrderId: checked.existing.id } : {}) });
    if (!card) { await this.#say(chatId, LINES.unread); return; }
    const messageId = await this.#say(chatId, cardText(card, c, o.cut, this.#tail(LINES.footer, o.gate), checked.existing), cardKeys(card));
    if (messageId !== undefined) await this.#d.store.setMessage(card.id, messageId);
  }

  #tail(line: string, gate: Gate): string { return gate.paused ? `${line}\n${LINES.waits}` : line; }

  /**
   * What the account's open orders and session say before the card is shown: a second shield is already on, the
   * ceiling counts the card's orders too, a buy over the per-trade cap is cut to it and says so, and an open order of
   * the same kind on the token is named, for Replace or Add both (FR-012, FR-012d, FR-013).
   */
  async #check(tgId: string, c: Candidate, stored: StoredProposal[], gate: Gate): Promise<{ proposals: StoredProposal[]; existing?: Order } | string> {
    const open = await this.#d.build.orders.openFor(tgId, this.#d.build.session.chainId);
    const here = open.filter((o) => o.token.toLowerCase() === c.address);
    if (stored.some((p) => p.kind === "shield") && here.some((o) => o.kind === "shield")) return SHIELD_ON;
    if (open.length + stored.length > MAX_OPEN_ORDERS) return CEILING;
    const buys = stored.some((p) => p.kind === "limit" || p.kind === "dca");
    if (buys && gate.capWei === 0n) return LINES.noCap;
    const proposals = stored.map((p): StoredProposal => {
      if (p.ethWei === undefined || BigInt(p.ethWei) <= gate.capWei) return p;
      return { ...p, ethWei: gate.capWei.toString(), note: `your session allows ${eth(gate.capWei)} ETH a trade, so ${eth(gate.capWei)} ETH` };
    });
    const existing = here.find((o) => o.kind !== "shield" && proposals.some((p) => p.kind === o.kind));
    return existing ? { proposals, existing } : { proposals };
  }

  /** `sc:<id>:ok` or `sc:<id>:no`, once per card (FR-006); what comes back is the tap's toast. */
  async handleCallback(chatId: string, tgId: string, data: string, messageId?: number): Promise<string | undefined> {
    if (data.startsWith("sq:")) return this.#answer(chatId, tgId, data, messageId);
    const [, id = "", verb] = data.split(":");
    const card = await this.#d.store.getCard(id);
    if (!card || card.tgId !== tgId || card.chatId !== chatId) return LINES.expired;
    // Past its ten minutes, any tap expires it here, before the sweep gets to it (FR-005).
    if (card.state === "proposed" && this.#now.getTime() - Date.parse(card.createdAt) >= CARD_MS) {
      if (await this.#d.store.transition(card.id, "expired", this.#now)) await this.#edit(card, LINES.expired);
      return LINES.expired;
    }
    if (verb === "no") return this.#cancel(card);
    if (verb === "ok" || verb === "add" || verb === "rep") return this.#confirm(card, verb === "rep");
    return undefined;
  }

  /** `sq:<chat>:<i>` fills the draft and goes on to the card, once (FR-008); `sq:<chat>:x` drops the question. */
  async #answer(chatId: string, tgId: string, data: string, messageId: number | undefined): Promise<string | undefined> {
    const [, chatKey, pick = ""] = data.split(":");
    if (chatKey !== chatId) return LINES.questionGone;
    const edit = (text: string) => editIn(this.#d.telegram, chatId, messageId, text);
    if (pick === "x") { await this.#d.store.dropPending(chatId); await edit(LINES.cancelled); return undefined; }
    const got = await this.#d.store.consumePending(chatId, this.#now);
    if (!got || "expired" in got || got.question.tgId !== tgId) return LINES.questionGone;
    const { partial, sentenceHash } = got.question;
    const choice = partial.choices[Number(pick)];
    if (!/^\d+$/.test(pick) || choice === undefined) return LINES.questionGone;
    await edit(esc(partial.labels?.[Number(pick)] ?? choice));
    const link = await this.#d.links.getLink(tgId);
    const gate = link ? await this.#gate(link.account) : undefined;
    if (!link || !gate) { await this.#d.connect(chatId, tgId); return undefined; }
    const draft = apply({ proposals: partial.draft as Proposal[], ...(partial.pinned ? { pinned: partial.pinned } : {}) }, partial.missing, choice);
    await this.#card(chatId, tgId, sentenceHash, draft, await this.#candidates(link.account), { cut: false, asked: true, gate });
    return undefined;
  }

  /** The answer to a tap on a card that has already left Proposed. */
  async #byState(id: string): Promise<string> {
    const state = (await this.#d.store.getCard(id))?.state;
    return state === "placed" ? LINES.already : state === "cancelled" ? LINES.cancelled : LINES.expired;
  }

  async #edit(card: SentenceCard, text: string, keyboard: Keyboard = kb()): Promise<void> {
    await editIn(this.#d.telegram, card.chatId, card.messageId, text, keyboard);
  }

  async #cancel(card: SentenceCard): Promise<string | undefined> {
    if (!(await this.#d.store.transition(card.id, "cancelled", this.#now))) return this.#byState(card.id);
    await this.#edit(card, LINES.cancelled);
    return undefined;
  }

  /**
   * Every order is built through the buttons' preflight before the card moves, so a refusal places nothing and
   * leaves the card to tap again; the move to placed is the one atomic step, and only its winner stores the orders.
   * A price that moved more than 5% since the card re-renders it instead (FR-014); Replace closes the named order.
   */
  async #confirm(card: SentenceCard, replace: boolean): Promise<string | undefined> {
    if (card.state !== "proposed") return this.#byState(card.id);
    const link = await this.#d.links.getLink(card.tgId);
    const gate = link ? await this.#gate(link.account) : undefined;
    if (!link || !gate) { await this.#d.connect(card.chatId, card.tgId); return undefined; }
    const c = await this.#candidate(card.token as Address, link.account);
    const existing = card.existingOrderId ? (await this.#d.build.orders.openFor(card.tgId, this.#d.build.session.chainId)).find((o) => o.id === card.existingOrderId) : undefined;
    const drift = c.perEth > card.perEthAtCard ? c.perEth - card.perEthAtCard : card.perEthAtCard - c.perEth;
    if (drift * B > MOVED_BPS * card.perEthAtCard) return this.#moved(card, c, gate, existing);
    const built = await this.#buildAll(card, link.account, c.decimals, gate);
    if (!Array.isArray(built)) { await this.#say(card.chatId, built.reason, built.buttons); return undefined; }
    // Each build counted the open orders on its own, so orders set since the card could pass the ceiling together.
    const open = (await this.#d.build.orders.openFor(card.tgId, this.#d.build.session.chainId)).length - (replace && existing ? 1 : 0);
    if (open + built.length > MAX_OPEN_ORDERS) { await this.#say(card.chatId, CEILING, kb([btn("📋 Orders", "orders")])); return undefined; }
    if (!(await this.#d.store.transition(card.id, "placed", this.#now))) return this.#byState(card.id);
    if (replace && card.existingOrderId) await this.#d.build.orders.cancel(card.existingOrderId);
    for (const order of built) await this.#d.build.orders.put(order);
    await this.#d.store.addEval({ sentenceHash: card.sentenceHash, context: { held: [{ symbol: c.symbol, tail: tail(card.token) }], perEth: { [tail(card.token)]: card.perEthAtCard.toString() } }, accepted: card.proposals, at: this.#now.toISOString() });
    await this.#edit(card, cardText(card, c, false, this.#tail(LINES.placed, gate)));
    return undefined;
  }

  /** The card again at the new price, still Proposed, nothing placed. */
  async #moved(card: SentenceCard, c: Candidate, gate: Gate, existing: Order | undefined): Promise<string> {
    const proposals = card.proposals.map((p) => reprice(p, c.perEth));
    if (!(await this.#d.store.rerender(card.id, c.perEth, proposals))) return this.#byState(card.id);
    const next = { ...card, perEthAtCard: c.perEth, proposals };
    await this.#edit(next, cardText(next, c, false, this.#tail(`${LINES.moved}\n${LINES.footer}`, gate), existing), cardKeys(next));
    return LINES.moved;
  }

  async #candidate(address: Address, account: Address): Promise<Candidate> {
    const [info, balance] = await Promise.all([this.#d.build.reads.tokenInfo(address), this.#d.build.reads.tokenBalance(address, account)]);
    return { symbol: info.symbol, address, decimals: info.decimals, balance, perEth: info.perEth, hasPool: info.hasPool };
  }

  /** Each proposal through the shared preflight, levels as fixed on the card (FR-014); the first refusal stops it. */
  async #buildAll(card: SentenceCard, account: Address, decimals: number, gate: Gate): Promise<Order[] | Refusal> {
    const who = { tgId: card.tgId, account, token: card.token as Address };
    const build = gate.paused ? { ...this.#d.build, session: waiting(this.#d.build.session) } : this.#d.build;
    const orders: Order[] = [];
    for (const p of card.proposals) {
      const ethWei = BigInt(p.ethWei ?? "0");
      let b: Built;
      if (p.kind === "tp" || p.kind === "sl") b = await buildExit(build, { ...who, kind: p.kind, move: (p.moveBps ?? 0) / 100, pct: p.sizePct ?? 0 }, RETRY);
      else if (p.kind === "limit") b = await buildBuy(build, { ...who, kind: "limit", ethWei, perEth: fmt(BigInt(p.levelPerEth), decimals, decimals) }, RETRY);
      else if (p.kind === "dca") b = await buildBuy(build, { ...who, kind: "dca", ethWei, hours: (p.everyMs ?? 0) / 3_600_000, times: p.count ?? 0 }, RETRY);
      else b = await buildShield(build, who);
      if (!b.ok) return b;
      orders.push(p.kind === "tp" || p.kind === "sl" ? { ...b.order, triggerPerEth: BigInt(p.levelPerEth) } : b.order);
    }
    return orders;
  }
}
