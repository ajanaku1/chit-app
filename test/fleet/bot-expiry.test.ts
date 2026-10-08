/** The session's end, told once three days before and once when it has come, each with the Renew button; never twice, never for a session that is not ending. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, parseEther } from "viem";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { ENDED_SAY_MS, EXPIRY_WARN_MS, ExpiryNotifier, MemoryExpiryNoteStore, NeonExpiryNoteStore, type ExpirySql } from "../../src/fleet/bot-expiry.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import type { SessionView } from "../../src/fleet/session-keys.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";

const clock = new Date("2026-10-08T12:00:00Z");
const HOUR = 3_600_000;
const at = (ms: number) => Math.floor((clock.getTime() + ms) / 1000);
const acct = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const view = (p: Partial<SessionView>): SessionView => ({ exists: true, paused: false, revoked: false, expiry: at(30 * 24 * HOUR), maxValuePerCall: parseEther("0.05").toString(), totalValueCap: parseEther("0.5").toString(), spentValue: "0", calls: 0, ...p });

const setup = (sessions: Map<string, SessionView | Error>) => {
  const links = new MemoryBotLinkStore();
  const telegram = new RecordingTelegram();
  const notes = new MemoryExpiryNoteStore();
  const session = {
    chainId: 4663, signer: "0x00000000000000000000000000000000000000b0",
    async sessionOf(a: Address) { const s = sessions.get(a.toLowerCase()); if (s instanceof Error) throw s; if (!s) throw new Error("no such account"); return s; },
  } as unknown as SessionChain;
  const notifier = new ExpiryNotifier({ links, session, telegram, notes });
  const link = (tgId: string, account: Address, chainId = 4663) => links.putLink({ tgId, account, owner: acct(0x11), chainId, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  const sends = () => telegram.sent.filter((o) => o.kind === "send") as { chatId: string; text: string; keyboard?: { callback_data?: string }[][] }[];
  return { notifier, link, sends, sessions };
};

test("a session that ends within 72 hours gets one message with the Renew button, and only one; one further out gets nothing", async () => {
  const sessions = new Map<string, SessionView | Error>([
    [acct(1), view({ expiry: at(EXPIRY_WARN_MS) })],
    [acct(2), view({ expiry: at(EXPIRY_WARN_MS + HOUR) })],
  ]);
  const { notifier, link, sends } = setup(sessions);
  await link("1", acct(1));
  await link("2", acct(2));
  assert.deepEqual(await notifier.run(clock), { soon: 1, ended: 0 });
  const [m] = sends();
  assert.equal(m!.chatId, "1");
  assert.match(m!.text, /⏳ <b>your session with the bot ends in 72 hours<\/b>, 2026-10-11 12:00 UTC\./);
  assert.match(m!.text, /a session can't be extended, so renewing is a new account on the same wallet/);
  assert.deepEqual(m!.keyboard!.flat().map((b) => b.callback_data), ["connect"], "Renew is the bot's own Connect, which mints a live link when tapped");
  assert.deepEqual(await notifier.run(new Date(clock.getTime() + HOUR / 2)), { soon: 0, ended: 0 }, "the next pass says nothing more");
  assert.equal(sends().length, 1);
  // An hour on, the second is inside its 72 hours: its own one message.
  assert.deepEqual(await notifier.run(new Date(clock.getTime() + HOUR)), { soon: 1, ended: 0 });
  assert.deepEqual(sends().map((m) => m.chatId), ["1", "2"]);
});

test("a session that has ended gets one message with the Renew button, after its warning or without one; never twice", async () => {
  const sessions = new Map<string, SessionView | Error>([
    [acct(1), view({ expiry: at(2 * HOUR) })],
    [acct(2), view({ expiry: at(-HOUR) })],
  ]);
  const { notifier, link, sends } = setup(sessions);
  await link("1", acct(1));
  await link("2", acct(2));
  assert.deepEqual(await notifier.run(clock), { soon: 1, ended: 1 });
  const ended = sends().find((m) => m.chatId === "2")!;
  assert.match(ended.text, /⌛ <b>your session with the bot ended<\/b> 2026-10-08 11:00 UTC\./);
  assert.match(ended.text, /what the account holds is still yours/);
  assert.deepEqual(ended.keyboard!.flat().map((b) => b.callback_data), ["connect"]);
  // Three hours on, the first has ended too: one more message for it, none for the second.
  assert.deepEqual(await notifier.run(new Date(clock.getTime() + 3 * HOUR)), { soon: 0, ended: 1 });
  assert.deepEqual(sends().map((m) => m.chatId), ["1", "2", "1"]);
  assert.match(sends().at(-1)!.text, /ended<\/b> 2026-10-08 14:00 UTC/);
  assert.deepEqual(await notifier.run(new Date(clock.getTime() + 4 * HOUR)), { soon: 0, ended: 0 });
});

test("nothing for a session that lapsed long ago, was revoked, never existed, sits on another chain, or cannot be read; one bad read does not stop the pass", async () => {
  const sessions = new Map<string, SessionView | Error>([
    [acct(1), view({ expiry: at(-ENDED_SAY_MS - HOUR) })],
    [acct(2), view({ expiry: at(HOUR), revoked: true })],
    [acct(3), view({ exists: false, expiry: 0 })],
    [acct(4), view({ expiry: at(HOUR) })],
    [acct(5), new Error("rpc 429")],
    [acct(6), view({ expiry: at(HOUR), paused: true })],
  ]);
  const { notifier, link, sends } = setup(sessions);
  await link("1", acct(1));
  await link("2", acct(2));
  await link("3", acct(3));
  await link("4", acct(4), 46630);
  await link("5", acct(5));
  await link("6", acct(6));
  assert.deepEqual(await notifier.run(clock), { soon: 1, ended: 0 });
  assert.deepEqual(sends().map((m) => m.chatId), ["6"], "a paused session still ends, so it is told");
});

test("a renewal is a new session with its own end: it gets its own warning", async () => {
  const sessions = new Map<string, SessionView | Error>([[acct(1), view({ expiry: at(HOUR) })]]);
  const { notifier, link, sends } = setup(sessions);
  await link("1", acct(1));
  await notifier.run(clock);
  // The owner renewed: a new account, linked again, granted for 30 days; 28 days on it is near its end.
  sessions.set(acct(2), view({ expiry: at(30 * 24 * HOUR) }));
  await link("1", acct(2));
  assert.deepEqual(await notifier.run(new Date(clock.getTime() + 2 * HOUR)), { soon: 0, ended: 0 }, "the old account is no longer linked; the new one is far from its end");
  assert.deepEqual(await notifier.run(new Date(clock.getTime() + 28 * 24 * HOUR)), { soon: 1, ended: 0 });
  assert.equal(sends().length, 2);
});

test("neon: a note is claimed in one insert that does nothing when it is there already", async () => {
  const calls: { query: string; params?: unknown[] }[] = [];
  const taken = new Set<string>();
  const sql: ExpirySql = {
    async query(query, params) {
      calls.push({ query, ...(params ? { params } : {}) });
      if (/^CREATE/.test(query.trim())) return [];
      const key = JSON.stringify(params!.slice(0, 5));
      if (taken.has(key)) return [];
      taken.add(key);
      return [{ tg_id: params![0] }];
    },
  };
  const store = new NeonExpiryNoteStore(sql);
  const note = { tgId: "1", account: acct(0xab), chainId: 4663, expiry: at(HOUR), stage: "soon" as const };
  assert.equal(await store.claim(note, clock), true);
  assert.equal(await store.claim(note, clock), false);
  assert.equal(await store.claim({ ...note, stage: "ended" }, clock), true, "the other stage is its own note");
  const insert = calls.find((c) => c.query.includes("INSERT INTO bot_expiry_notes"))!;
  assert.match(insert.query, /ON CONFLICT DO NOTHING RETURNING tg_id/);
  assert.ok(calls.some((c) => /PRIMARY KEY \(tg_id, account, chain_id, expiry, stage\)/.test(c.query)));
});
