/**
 * The session's end, said before it comes and when it has come. Every
 * session an owner grants the bot's key has an expiry, and past it the
 * account refuses every buy, sell and standing order in the contract's
 * words; nobody should find that out from a refused order. So the orders
 * cron (api/bot/orders.js) also walks the links on its chain once a pass and
 * reads each account's session for the bot's key: one that ends within
 * three days gets one message, and one that has ended gets one more, each
 * with the Renew button.
 *
 * Renewing is not an extension. The account never grants a key twice and
 * has no way to move an expiry (contracts/fleet/SessionAccount.sol), so a
 * renewal is a new account on the same wallet with the bot's key granted
 * again: the button is the bot's own Connect (callback `connect`), which
 * mints a fresh link at the moment it is tapped, so the Sessions page opens
 * with the key and the beta's caps filled in. A link minted here would be
 * dead before most owners read the message, the link nonce living fifteen
 * minutes.
 *
 * Each message is sent once per stage per expiry: a note is claimed in one
 * statement before the send, keyed by the link, the account, the chain, the
 * expiry and the stage, so two runs at once send it once and a renewed
 * session (a new expiry, a new account) gets its own cycle. A session that
 * ended more than `ENDED_SAY_MS` ago is left alone, so the first pass after
 * this ships does not wake every account that lapsed weeks back. A revoked
 * session or none at all is not an expiry and says nothing; a paused one
 * still ends, so it is told. A read that fails skips that link this pass.
 */

import type { Address } from "viem";
import type { BotLinkStore } from "./bot-link.js";
import type { SessionChain } from "./bot-session-chain.js";
import type { Telegram } from "./bot-telegram.js";

/** How far ahead the first message goes: three days before the end. */
export const EXPIRY_WARN_MS = 72 * 3_600_000;
/** A session that ended longer ago than this is not told: the message would be news to nobody. */
export const ENDED_SAY_MS = 7 * 24 * 3_600_000;

export type ExpiryStage = "soon" | "ended";
export type ExpiryNote = { tgId: string; account: Address; chainId: number; expiry: number; stage: ExpiryStage };

export interface ExpiryNoteStore {
  /** One statement: true when this note was not there and is now, false when a run already took it. */
  claim(n: ExpiryNote, at: Date): Promise<boolean>;
}

export type ExpiryReport = { soon: number; ended: number };

export type ExpiryNotifierDeps = { links: BotLinkStore; session: SessionChain; telegram: Telegram; notes: ExpiryNoteStore };

const utc = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
const renew = [[{ text: "🔑 Renew", callback_data: "connect" }]];

export const soonText = (expiry: number, now: Date): string => {
  const hours = Math.max(1, Math.round((expiry * 1000 - now.getTime()) / 3_600_000));
  return [
    `⏳ <b>your session with the bot ends in ${hours} hour${hours === 1 ? "" : "s"}</b>, ${utc(expiry)} UTC.`,
    "after that the bot can't buy or sell for this account and your standing orders wait.",
    "a session can't be extended, so renewing is a new account on the same wallet with the bot's key granted again: tap 🔑 Renew, start a new account on the Sessions page (the key and the caps are filled in), then withdraw what this one holds to your wallet and fund the new one.",
  ].join("\n");
};

export const endedText = (expiry: number): string => [
  `⌛ <b>your session with the bot ended</b> ${utc(expiry)} UTC.`,
  "the bot can't buy or sell for this account until it is renewed, and your standing orders wait. what the account holds is still yours: withdraw it from the Sessions page any time.",
  "renewing is a new account on the same wallet with the bot's key granted again: tap 🔑 Renew and the Sessions page opens with the key and the caps filled in.",
].join("\n");

export class ExpiryNotifier {
  readonly #d: ExpiryNotifierDeps;
  constructor(d: ExpiryNotifierDeps) { this.#d = d; }

  /** One pass over the links on the session's chain; each link at most one message a pass. */
  async run(now: Date): Promise<ExpiryReport> {
    const report: ExpiryReport = { soon: 0, ended: 0 };
    const chainId = this.#d.session.chainId;
    for (const link of await this.#d.links.linksOn(chainId)) {
      let s;
      try { s = await this.#d.session.sessionOf(link.account); }
      catch (e) { console.error(`bot expiry: session of ${link.account}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); continue; }
      if (!s.exists || s.revoked || !s.expiry) continue;
      const left = s.expiry * 1000 - now.getTime();
      const stage: ExpiryStage | undefined = left <= 0 ? (-left <= ENDED_SAY_MS ? "ended" : undefined) : left <= EXPIRY_WARN_MS ? "soon" : undefined;
      if (!stage) continue;
      if (!(await this.#d.notes.claim({ tgId: link.tgId, account: link.account, chainId, expiry: s.expiry, stage }, now))) continue;
      try {
        await this.#d.telegram.deliver({ kind: "send", chatId: link.tgId, text: stage === "soon" ? soonText(s.expiry, now) : endedText(s.expiry), keyboard: renew });
        report[stage] += 1;
      } catch (e) { console.error(`bot expiry: telegram: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return report;
  }
}

export class MemoryExpiryNoteStore implements ExpiryNoteStore {
  readonly notes = new Set<string>();
  async claim(n: ExpiryNote) {
    const key = [n.tgId, n.account.toLowerCase(), n.chainId, n.expiry, n.stage].join("|");
    if (this.notes.has(key)) return false;
    this.notes.add(key);
    return true;
  }
}

export type ExpirySql = { query(sql: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_expiry_notes (tg_id TEXT NOT NULL, account TEXT NOT NULL, chain_id INTEGER NOT NULL, expiry BIGINT NOT NULL, stage TEXT NOT NULL, noted_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tg_id, account, chain_id, expiry, stage))`,
];

/** Neon, beside the links: the claim is one insert that does nothing on a note already there. */
export class NeonExpiryNoteStore implements ExpiryNoteStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: ExpirySql) {}
  #init(): Promise<void> { return (this.#ready ??= (async () => { for (const s of SCHEMA) await this.sql.query(s); })().catch((e) => { this.#ready = undefined; throw e; })); }
  async claim(n: ExpiryNote, at: Date) {
    await this.#init();
    const rows = await this.sql.query(
      `INSERT INTO bot_expiry_notes (tg_id, account, chain_id, expiry, stage, noted_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING tg_id`,
      [n.tgId, n.account.toLowerCase(), n.chainId, n.expiry, n.stage, at.toISOString()],
    );
    return rows.length === 1;
  }
}
