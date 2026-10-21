/**
 * The sentence desk's state (specs/006-agent-sentences/data-model.md): the
 * cards the bot showed, at most one question waiting per chat, the per-day
 * counts and spend, and the hashed evaluation records. No table holds
 * sentence text: a card carries the sentence's HMAC and nothing else of it.
 *
 * One Proposed card per chat is the database's rule (a partial unique
 * index), not the handler's memory, and every move out of `proposed` is one
 * UPDATE whose row count decides the reply, so two taps on Confirm place
 * once whichever instance answers each.
 */
import { randomBytes } from "node:crypto";

export type CardState = "proposed" | "placed" | "cancelled" | "expired";
export type StoredProposal = { kind: "limit" | "dca" | "tp" | "sl" | "shield"; sizePct?: number; ethWei?: string; moveBps?: number; levelPerEth: string; everyMs?: number; count?: number; note?: string; replaces?: string };
export type SentenceCard = {
  id: string; chatId: string; tgId: string; messageId?: number; state: CardState; sentenceHash: string; token: string;
  perEthAtCard: bigint; proposals: StoredProposal[]; existingOrderId?: string; createdAt: string; resolvedAt?: string;
};
export type NewCard = Omit<SentenceCard, "id" | "state" | "messageId" | "resolvedAt">;
export type PendingQuestion = { chatId: string; tgId: string; sentenceHash: string; partial: { missing: "token" | "size" | "direction"; draft: unknown[]; choices: string[] }; leaseUntil: string };
export type EvalRecord = { sentenceHash: string; context: { held: { symbol: string; tail: string }[]; perEth: Record<string, string> }; accepted: StoredProposal[]; at: string };

export interface SentenceStore {
  /** The card, or undefined when the chat already has a Proposed one. */
  createCard(card: NewCard): Promise<SentenceCard | undefined>;
  getCard(id: string): Promise<SentenceCard | undefined>;
  proposedIn(chatId: string): Promise<SentenceCard | undefined>;
  setMessage(id: string, messageId: number): Promise<void>;
  /** `proposed → placed | cancelled | expired`; false when the card had already left `proposed`. */
  transition(id: string, to: Exclude<CardState, "proposed">, at: Date): Promise<boolean>;
  /** The price-moved re-render: still `proposed`, new levels and reference price. */
  rerender(id: string, perEthAtCard: bigint, proposals: StoredProposal[]): Promise<boolean>;
  /** Every Proposed card created before `before` becomes `expired`; how many. */
  expireOlderThan(before: Date, at: Date): Promise<number>;
  /** The chat's Proposed card, if any, becomes `expired` (a new sentence arrived); how many. */
  expireChat(chatId: string, at: Date): Promise<number>;
  setPending(q: PendingQuestion): Promise<void>;
  /** The question, removed, when one is waiting and its lease holds; an expired one is removed and reported as such. */
  consumePending(chatId: string, now: Date): Promise<{ question: PendingQuestion } | { expired: true } | undefined>;
  dropPending(chatId: string): Promise<void>;
  /** One more sentence today for this trader, unless that would pass `limit`; the count after. */
  bump(tgId: string, day: string, limit: number): Promise<{ ok: boolean; n: number }>;
  /** Adds one call's cost to the day; the day's total after. */
  addSpend(day: string, usdMicros: bigint): Promise<bigint>;
  /** True once per day: the caller that gets true sends the alert. */
  claimAlert(day: string, at: Date): Promise<boolean>;
  addEval(record: EvalRecord): Promise<void>;
}

export const newCardId = (): string => randomBytes(8).toString("hex");
/** The UTC day a moment falls on, as the stores key it. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export class MemorySentenceStore implements SentenceStore {
  readonly cards = new Map<string, SentenceCard>();
  readonly pending = new Map<string, PendingQuestion>();
  readonly counts = new Map<string, number>();
  readonly spend = new Map<string, { usdMicros: bigint; calls: number; alertedAt?: string }>();
  readonly evals: EvalRecord[] = [];
  async createCard(card: NewCard) {
    if (await this.proposedIn(card.chatId)) return undefined;
    const row: SentenceCard = { ...card, id: newCardId(), state: "proposed" };
    this.cards.set(row.id, row);
    return row;
  }
  async getCard(id: string) { return this.cards.get(id); }
  async proposedIn(chatId: string) { return [...this.cards.values()].find((c) => c.chatId === chatId && c.state === "proposed"); }
  async setMessage(id: string, messageId: number) { const c = this.cards.get(id); if (c) c.messageId = messageId; }
  async transition(id: string, to: Exclude<CardState, "proposed">, at: Date) {
    const c = this.cards.get(id);
    if (!c || c.state !== "proposed") return false;
    c.state = to; c.resolvedAt = at.toISOString();
    return true;
  }
  async rerender(id: string, perEthAtCard: bigint, proposals: StoredProposal[]) {
    const c = this.cards.get(id);
    if (!c || c.state !== "proposed") return false;
    c.perEthAtCard = perEthAtCard; c.proposals = proposals;
    return true;
  }
  async #expire(pick: (c: SentenceCard) => boolean, at: Date) {
    let n = 0;
    for (const c of this.cards.values()) if (c.state === "proposed" && pick(c) && (await this.transition(c.id, "expired", at))) n++;
    return n;
  }
  async expireOlderThan(before: Date, at: Date) { return this.#expire((c) => Date.parse(c.createdAt) < before.getTime(), at); }
  async expireChat(chatId: string, at: Date) { return this.#expire((c) => c.chatId === chatId, at); }
  async setPending(q: PendingQuestion) { this.pending.set(q.chatId, q); }
  async consumePending(chatId: string, now: Date) {
    const q = this.pending.get(chatId);
    if (!q) return undefined;
    this.pending.delete(chatId);
    return Date.parse(q.leaseUntil) > now.getTime() ? { question: q } : { expired: true as const };
  }
  async dropPending(chatId: string) { this.pending.delete(chatId); }
  async bump(tgId: string, day: string, limit: number) {
    const key = `${tgId}:${day}`, n = this.counts.get(key) ?? 0;
    if (n >= limit) return { ok: false, n };
    this.counts.set(key, n + 1);
    return { ok: true, n: n + 1 };
  }
  async addSpend(day: string, usdMicros: bigint) {
    const s = this.spend.get(day) ?? { usdMicros: 0n, calls: 0 };
    s.usdMicros += usdMicros; s.calls += 1; this.spend.set(day, s);
    return s.usdMicros;
  }
  async claimAlert(day: string, at: Date) {
    const s = this.spend.get(day);
    if (!s || s.alertedAt) return false;
    s.alertedAt = at.toISOString();
    return true;
  }
  async addEval(record: EvalRecord) { this.evals.push(record); }
}

export type SentenceSql = { query(sql: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_sentence_cards (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, tg_id TEXT NOT NULL, message_id BIGINT, state TEXT NOT NULL, sentence_hash TEXT NOT NULL, token TEXT NOT NULL, per_eth_at_card NUMERIC(40,0) NOT NULL, proposals JSONB NOT NULL, existing_order_id TEXT, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bot_sentence_cards_one_proposed ON bot_sentence_cards (chat_id) WHERE state = 'proposed'`,
  `CREATE INDEX IF NOT EXISTS bot_sentence_cards_sweep ON bot_sentence_cards (state, created_at)`,
  `CREATE TABLE IF NOT EXISTS bot_sentence_pending (chat_id TEXT PRIMARY KEY, tg_id TEXT NOT NULL, sentence_hash TEXT NOT NULL, partial JSONB NOT NULL, lease_until TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bot_sentence_counts (tg_id TEXT NOT NULL, day DATE NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tg_id, day))`,
  `CREATE TABLE IF NOT EXISTS bot_sentence_spend (day DATE PRIMARY KEY, usd_micros BIGINT NOT NULL, calls INTEGER NOT NULL, alerted_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS bot_sentence_evals (id BIGSERIAL PRIMARY KEY, sentence_hash TEXT NOT NULL, context JSONB NOT NULL, accepted JSONB NOT NULL, at TIMESTAMPTZ NOT NULL)`,
];

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const rowCard = (r: Record<string, unknown>): SentenceCard => ({
  id: String(r.id), chatId: String(r.chat_id), tgId: String(r.tg_id), ...(r.message_id != null ? { messageId: Number(r.message_id) } : {}),
  state: r.state as CardState, sentenceHash: String(r.sentence_hash), token: String(r.token), perEthAtCard: BigInt(String(r.per_eth_at_card)),
  proposals: r.proposals as StoredProposal[], ...(r.existing_order_id != null ? { existingOrderId: String(r.existing_order_id) } : {}),
  createdAt: iso(r.created_at), ...(r.resolved_at != null ? { resolvedAt: iso(r.resolved_at) } : {}),
});
const rowPending = (r: Record<string, unknown>): PendingQuestion => ({ chatId: String(r.chat_id), tgId: String(r.tg_id), sentenceHash: String(r.sentence_hash), partial: r.partial as PendingQuestion["partial"], leaseUntil: iso(r.lease_until) });
const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

export class NeonSentenceStore implements SentenceStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: SentenceSql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async #q(sql: string, params: unknown[]) { await this.#init(); return this.sql.query(sql, params); }
  async createCard(card: NewCard) {
    const id = newCardId();
    try {
      await this.#q(`INSERT INTO bot_sentence_cards (id, chat_id, tg_id, state, sentence_hash, token, per_eth_at_card, proposals, existing_order_id, created_at) VALUES ($1,$2,$3,'proposed',$4,$5,$6,$7,$8,$9)`,
        [id, card.chatId, card.tgId, card.sentenceHash, card.token, card.perEthAtCard.toString(), JSON.stringify(card.proposals), card.existingOrderId ?? null, card.createdAt]);
    } catch (e) { if (isUnique(e)) return undefined; throw e; }
    return this.getCard(id);
  }
  async getCard(id: string) { const [r] = await this.#q(`SELECT * FROM bot_sentence_cards WHERE id = $1`, [id]); return r ? rowCard(r) : undefined; }
  async proposedIn(chatId: string) { const [r] = await this.#q(`SELECT * FROM bot_sentence_cards WHERE chat_id = $1 AND state = 'proposed'`, [chatId]); return r ? rowCard(r) : undefined; }
  async setMessage(id: string, messageId: number) { await this.#q(`UPDATE bot_sentence_cards SET message_id = $2 WHERE id = $1`, [id, messageId]); }
  async transition(id: string, to: Exclude<CardState, "proposed">, at: Date) {
    return (await this.#q(`UPDATE bot_sentence_cards SET state = $2, resolved_at = $3 WHERE id = $1 AND state = 'proposed' RETURNING id`, [id, to, at.toISOString()])).length === 1;
  }
  async rerender(id: string, perEthAtCard: bigint, proposals: StoredProposal[]) {
    return (await this.#q(`UPDATE bot_sentence_cards SET per_eth_at_card = $2, proposals = $3 WHERE id = $1 AND state = 'proposed' RETURNING id`, [id, perEthAtCard.toString(), JSON.stringify(proposals)])).length === 1;
  }
  async expireOlderThan(before: Date, at: Date) {
    return (await this.#q(`UPDATE bot_sentence_cards SET state = 'expired', resolved_at = $2 WHERE state = 'proposed' AND created_at < $1 RETURNING id`, [before.toISOString(), at.toISOString()])).length;
  }
  async expireChat(chatId: string, at: Date) {
    return (await this.#q(`UPDATE bot_sentence_cards SET state = 'expired', resolved_at = $2 WHERE state = 'proposed' AND chat_id = $1 RETURNING id`, [chatId, at.toISOString()])).length;
  }
  async setPending(q: PendingQuestion) {
    await this.#q(`INSERT INTO bot_sentence_pending (chat_id, tg_id, sentence_hash, partial, lease_until) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_id) DO UPDATE SET tg_id = EXCLUDED.tg_id, sentence_hash = EXCLUDED.sentence_hash, partial = EXCLUDED.partial, lease_until = EXCLUDED.lease_until`,
      [q.chatId, q.tgId, q.sentenceHash, JSON.stringify(q.partial), q.leaseUntil]);
  }
  async consumePending(chatId: string, now: Date) {
    const [r] = await this.#q(`DELETE FROM bot_sentence_pending WHERE chat_id = $1 RETURNING *`, [chatId]);
    if (!r) return undefined;
    const q = rowPending(r);
    return Date.parse(q.leaseUntil) > now.getTime() ? { question: q } : { expired: true as const };
  }
  async dropPending(chatId: string) { await this.#q(`DELETE FROM bot_sentence_pending WHERE chat_id = $1`, [chatId]); }
  async bump(tgId: string, day: string, limit: number) {
    const [r] = await this.#q(`INSERT INTO bot_sentence_counts (tg_id, day, n) VALUES ($1, $2, 1) ON CONFLICT (tg_id, day) DO UPDATE SET n = bot_sentence_counts.n + 1 WHERE bot_sentence_counts.n < $3 RETURNING n`, [tgId, day, limit]);
    if (r) return { ok: true, n: Number(r.n) };
    const [c] = await this.#q(`SELECT n FROM bot_sentence_counts WHERE tg_id = $1 AND day = $2`, [tgId, day]);
    return { ok: false, n: Number(c?.n ?? 0) };
  }
  async addSpend(day: string, usdMicros: bigint) {
    const [r] = await this.#q(`INSERT INTO bot_sentence_spend (day, usd_micros, calls) VALUES ($1, $2, 1) ON CONFLICT (day) DO UPDATE SET usd_micros = bot_sentence_spend.usd_micros + EXCLUDED.usd_micros, calls = bot_sentence_spend.calls + 1 RETURNING usd_micros`, [day, usdMicros.toString()]);
    return BigInt(String(r?.usd_micros ?? 0));
  }
  async claimAlert(day: string, at: Date) {
    return (await this.#q(`UPDATE bot_sentence_spend SET alerted_at = $2 WHERE day = $1 AND alerted_at IS NULL RETURNING day`, [day, at.toISOString()])).length === 1;
  }
  async addEval(e: EvalRecord) {
    await this.#q(`INSERT INTO bot_sentence_evals (sentence_hash, context, accepted, at) VALUES ($1,$2,$3,$4)`, [e.sentenceHash, JSON.stringify(e.context), JSON.stringify(e.accepted), e.at]);
  }
}
