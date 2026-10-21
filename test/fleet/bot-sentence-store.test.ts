/**
 * The sentence desk's stores (bot-sentence-store.ts), the memory one and the
 * Neon one on PGlite, under the same cases: one Proposed card per chat is
 * the store's rule; a move out of `proposed` happens once; a question is
 * consumed once and dies with its lease; counts are per trader per UTC day
 * and stop at the limit; the spend alert is claimed once a day; nothing
 * stored is the sentence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySentenceStore, NeonSentenceStore, utcDay, type NewCard, type SentenceSql, type SentenceStore } from "../../src/fleet/bot-sentence-store.js";

const t0 = new Date("2026-10-21T10:00:00Z"), t1 = new Date("2026-10-21T10:05:00Z"), t2 = new Date("2026-10-21T10:11:00Z"), nextDay = new Date("2026-10-22T00:00:01Z");
const HASH = "a".repeat(64);
const card = (chatId: string, at = t0): NewCard => ({ chatId, tgId: `tg-${chatId}`, sentenceHash: HASH, token: "0x00000000000000000000000000000000000000ce", perEthAtCard: 1_000_000_000_000n, proposals: [{ kind: "tp", sizePct: 50, moveBps: 10_000, levelPerEth: "500000000000" }], createdAt: at.toISOString() });

const contract = (name: string, make: () => Promise<{ store: SentenceStore; done: () => Promise<void> }>): void => {
  test(`${name}: one Proposed card per chat; a transition out of proposed happens once; the sweep and a new sentence expire; a re-render keeps it proposed`, async () => {
    const { store, done } = await make();
    try {
      const a = await store.createCard(card("7"));
      assert.ok(a && a.state === "proposed" && a.id.length === 16 && a.perEthAtCard === 1_000_000_000_000n);
      assert.equal(await store.createCard(card("7", t1)), undefined, "a second Proposed card in the chat is refused");
      assert.ok(await store.createCard(card("8")), "another chat is its own");
      await store.setMessage(a.id, 42);
      assert.equal((await store.proposedIn("7"))?.messageId, 42);
      assert.equal(await store.rerender(a.id, 900_000_000_000n, [{ kind: "tp", sizePct: 50, moveBps: 10_000, levelPerEth: "450000000000" }]), true);
      assert.equal((await store.getCard(a.id))?.proposals[0]?.levelPerEth, "450000000000");
      assert.equal(await store.transition(a.id, "placed", t1), true);
      assert.equal(await store.transition(a.id, "cancelled", t1), false, "the second tap finds nothing to move");
      assert.equal(await store.rerender(a.id, 1n, []), false);
      assert.equal((await store.getCard(a.id))?.state, "placed");
      assert.equal((await store.getCard(a.id))?.resolvedAt, t1.toISOString());
      assert.ok(await store.createCard(card("7", t1)), "the chat may propose again once the first left proposed");
      assert.equal(await store.expireOlderThan(t1, t2), 1, "chat 8's card, from t0; chat 7's new one is from t1");
      assert.equal((await store.proposedIn("8")), undefined);
      assert.equal(await store.expireChat("7", t2), 1, "a new sentence expires the chat's card");
      assert.equal(await store.expireChat("7", t2), 0);
      assert.equal(await store.transition("nope", "expired", t2), false);
    } finally { await done(); }
  });

  test(`${name}: a question is consumed once, dies with its lease, and is dropped by a new sentence; counts stop at the limit and reset by UTC day; the alert is claimed once a day`, async () => {
    const { store, done } = await make();
    try {
      const q = { chatId: "7", tgId: "tg-7", sentenceHash: HASH, partial: { missing: "token" as const, draft: [], choices: ["PEPE", "PEPE2"] }, leaseUntil: t2.toISOString() };
      assert.equal(await store.consumePending("7", t0), undefined);
      await store.setPending(q);
      await store.setPending({ ...q, partial: { ...q.partial, choices: ["WIF", "WIF2"] } });
      assert.deepEqual(await store.consumePending("7", t1), { question: { ...q, partial: { ...q.partial, choices: ["WIF", "WIF2"] } } }, "the latest question, once");
      assert.equal(await store.consumePending("7", t1), undefined);
      await store.setPending(q);
      assert.deepEqual(await store.consumePending("7", t2), { expired: true }, "a tap at the lease's end finds it expired, and gone");
      assert.equal(await store.consumePending("7", t2), undefined);
      await store.setPending(q); await store.dropPending("7");
      assert.equal(await store.consumePending("7", t1), undefined);

      const day = utcDay(t0);
      for (let i = 1; i <= 3; i++) assert.deepEqual(await store.bump("tg-7", day, 3), { ok: true, n: i });
      assert.deepEqual(await store.bump("tg-7", day, 3), { ok: false, n: 3 }, "the fourth is refused and the row stays at the limit");
      assert.deepEqual(await store.bump("tg-7", day, 3), { ok: false, n: 3 });
      assert.deepEqual(await store.bump("tg-8", day, 3), { ok: true, n: 1 }, "one limit for everyone, counted per trader");
      assert.deepEqual(await store.bump("tg-7", utcDay(nextDay), 3), { ok: true, n: 1 }, "a new UTC day starts at one");

      assert.equal(await store.claimAlert(day, t0), false, "nothing spent, nothing to alert");
      assert.equal(await store.addSpend(day, 1_500n), 1_500n);
      assert.equal(await store.addSpend(day, 2_500n), 4_000n);
      assert.equal(await store.claimAlert(day, t1), true);
      assert.equal(await store.claimAlert(day, t2), false, "one alert per day");
      assert.equal(await store.addSpend(utcDay(nextDay), 10n), 10n);
      assert.equal(await store.claimAlert(utcDay(nextDay), nextDay), true);

      await store.addEval({ sentenceHash: HASH, context: { held: [{ symbol: "PEPE", tail: "00ce" }], perEth: { "00ce": "1000000000000" } }, accepted: card("7").proposals, at: t1.toISOString() });
    } finally { await done(); }
  });
};

contract("memory", async () => ({ store: new MemorySentenceStore(), done: async () => undefined }));

contract("neon store on pglite", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const port: SentenceSql = { query: async (q, params) => (await db.query(q, params)).rows as Record<string, unknown>[] };
  return { store: new NeonSentenceStore(port), done: () => db.close() };
});

test("nothing stored is the sentence: the Neon rows carry the hash and the shapes only", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    const store = new NeonSentenceStore({ query: async (q, params) => (await db.query(q, params)).rows as Record<string, unknown>[] });
    await store.createCard(card("7"));
    await store.setPending({ chatId: "7", tgId: "tg-7", sentenceHash: HASH, partial: { missing: "size", draft: [], choices: [] }, leaseUntil: t2.toISOString() });
    const columns = (await db.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'bot_sentence_%'`)).rows;
    assert.ok(columns.length > 0);
    assert.ok(!columns.some((c) => /^(text|sentence|body|message_text|sentence_text)$/.test(c.column_name)), columns.map((c) => c.column_name).join(","));
    assert.ok(columns.some((c) => c.column_name === "sentence_hash"));
  } finally { await db.close(); }
});
