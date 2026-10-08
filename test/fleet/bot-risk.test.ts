/** The risk watch: a graduation told once, a liquidity pull and a dev's sale told once a day with the exit, the holders before the group. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex, getAddress, parseEther } from "viem";
import { MemoryAlertStore } from "../../src/fleet/bot-alerts.js";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { MemoryRiskStore, NeonRiskStore, RiskWatch, type Graduation, type LaunchInfo, type Pull, type RiskPort, type RiskSql, type Sale } from "../../src/fleet/bot-risk.js";
import type { Keyboard } from "../../src/fleet/bot-telegram.js";

const TOKEN = "0x00000000000000000000000000000000000000ce" as Address;
const OTHER = "0x00000000000000000000000000000000000000cf" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Address;
const EMPTY = "0x00000000000000000000000000000000000000ab" as Address;
const DEV = "0x00000000000000000000000000000000000000de" as Address;
const POOL = ("0x" + "11".repeat(32)) as Hex;
const hash = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const clock = new Date("2026-10-08T12:00:00Z");

type Sent = { to: string; text: string; keyboard?: Keyboard };

const setup = (p: { opened?: Graduation[]; pulls?: Pull[]; sales?: Sale[]; launch?: LaunchInfo; balances?: Record<string, bigint> } = {}) => {
  const sent: Sent[] = [];
  const port: RiskPort = {
    async opened() { return p.opened ?? []; },
    async poolOf(token) { return token.toLowerCase() === TOKEN ? POOL : undefined; },
    async pulls(_f, _t, pools) { return (p.pulls ?? []).filter((x) => pools.has(x.poolId.toLowerCase())); },
    async sales(_f, _t, pools, min) { return (p.sales ?? []).filter((x) => pools.has(x.poolId.toLowerCase()) && x.ethOutWei >= min); },
  };
  const links = new MemoryBotLinkStore();
  const subs = new MemoryAlertStore();
  const reads = {
    async tokenInfo() { return { symbol: "PEPE" }; },
    async tokenBalance(_t: Address, a: Address) { return (p.balances ?? { [ACCOUNT]: 5n })[a.toLowerCase()] ?? 0n; },
  } as unknown as BotChain;
  const store = new MemoryRiskStore();
  let now = clock;
  const risk = new RiskWatch({
    port, store, chainId: 4663, reads, links, subs,
    held: { async tokens() { return [TOKEN]; }, async accounts() { return [ACCOUNT, EMPTY]; } },
    ...(p.launch ? { launch: p.launch } : {}),
    tell: async (tgId, text, keyboard) => { sent.push({ to: tgId, text, ...(keyboard ? { keyboard } : {}) }); },
    feed: { post: async (text, keyboard) => { sent.push({ to: "group", text, keyboard }); } },
    botUsername: "usechit_bot",
    now: () => now,
  });
  const link = (tgId: string, account: Address) => links.putLink({ tgId, account: getAddress(account), owner: DEV, chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  return { risk, sent, subs, link, store, later: (ms: number) => { now = new Date(clock.getTime() + ms); } };
};

const pull = (removed: bigint, left: bigint, n = 1): Pull => ({ token: TOKEN, poolId: POOL, txHash: hash(n), block: 10n, by: DEV, removed, left });
const buttons = (k?: Keyboard) => (k ?? []).flat().map((b) => ("callback_data" in b ? b.callback_data : (b as { url: string }).url));

test("a curve exit alerts once: the subscribers, then the group, with the door into the card; a pool for anything else is no graduation", async () => {
  const launch: LaunchInfo = async (t) => (t.toLowerCase() === TOKEN ? { deployer: DEV, graduated: true } : t.toLowerCase() === OTHER ? { deployer: DEV, graduated: false } : undefined);
  const opened: Graduation[] = [
    { token: TOKEN, poolId: POOL, txHash: hash(1), block: 10n },
    { token: OTHER, poolId: POOL, txHash: hash(2), block: 10n },
    { token: "0x00000000000000000000000000000000000000d0" as Address, poolId: POOL, txHash: hash(3), block: 10n },
  ];
  const { risk, sent, subs } = setup({ opened, launch });
  await subs.put({ tgId: "7", minEthWei: parseEther("0.5"), on: true });
  await subs.put({ tgId: "8", minEthWei: parseEther("0.5"), on: false });
  assert.deepEqual(await risk.run(10n, 20n), { graduated: 1, pulled: 0, devSold: 0 });
  assert.deepEqual(sent.map((s) => s.to), ["7", "group"], "the subscriber before the group; a subscription that is off hears nothing");
  assert.match(sent[0]!.text, /🎓 <b>\$PEPE graduated<\/b>: its launchpad curve is done and its Uniswap pool just opened/);
  assert.deepEqual(buttons(sent[1]!.keyboard), [`https://t.me/usechit_bot?start=t-${TOKEN}`]);
  assert.deepEqual(await risk.run(10n, 20n), { graduated: 0, pulled: 0, devSold: 0 }, "the same window again: told already");
  assert.equal(sent.length, 2);
  // Without the launchpad wired, a pool opening is never called a graduation.
  const bare = setup({ opened });
  assert.deepEqual(await bare.risk.run(10n, 20n), { graduated: 0, pulled: 0, devSold: 0 });
});

test("a liquidity drop alerts once a day with an exit button for the holder, before the group, and the group gets the card only", async () => {
  const { risk, sent, link, later } = setup({ pulls: [pull(60n, 40n)] });
  await link("7", ACCOUNT);
  await link("9", EMPTY);
  assert.deepEqual(await risk.run(10n, 20n), { graduated: 0, pulled: 1, devSold: 0 });
  assert.deepEqual(sent.map((s) => s.to), ["7", "group"], "the holder first; an account that sold out hears nothing");
  assert.match(sent[0]!.text, /🚨 <b>liquidity pulled from \$PEPE<\/b>: 60% of what sat at the price left the pool in one transaction/);
  assert.match(sent[0]!.text, /one tap sells all of it from your account/);
  assert.deepEqual(buttons(sent[0]!.keyboard), [`s:${TOKEN}:100`, `https://t.me/usechit_bot?start=t-${TOKEN}`], "the exit is the bot's own Sell 100%");
  assert.deepEqual(buttons(sent[1]!.keyboard), [`https://t.me/usechit_bot?start=t-${TOKEN}`], "no sale to tap from a group");
  assert.deepEqual(await risk.run(10n, 20n), { graduated: 0, pulled: 0, devSold: 0 }, "once");
  later(24 * 3_600_000);
  assert.deepEqual(await risk.run(30n, 40n), { graduated: 0, pulled: 1, devSold: 0 }, "a pull the next day is news again");
});

test("a pull under the line is not an alarm, and an empty pool is not divided by", async () => {
  const { risk, sent, link } = setup({ pulls: [pull(49n, 51n), pull(0n, 0n, 2)] });
  await link("7", ACCOUNT);
  assert.deepEqual(await risk.run(10n, 20n), { graduated: 0, pulled: 0, devSold: 0 });
  assert.equal(sent.length, 0);
});

test("the dev selling: the launchpad's deployer taking ETH out of the pool alerts once a day; anyone else, or a sale under the line, does not", async () => {
  const launch: LaunchInfo = async () => ({ deployer: DEV, graduated: true });
  const sales: Sale[] = [
    { token: TOKEN, poolId: POOL, txHash: hash(1), block: 10n, by: ACCOUNT, ethOutWei: parseEther("3") },
    { token: TOKEN, poolId: POOL, txHash: hash(2), block: 11n, by: DEV, ethOutWei: parseEther("0.01") },
    { token: TOKEN, poolId: POOL, txHash: hash(3), block: 12n, by: DEV, ethOutWei: parseEther("0.4") },
    { token: TOKEN, poolId: POOL, txHash: hash(4), block: 13n, by: DEV, ethOutWei: parseEther("0.5") },
  ];
  const { risk, sent, link } = setup({ sales, launch });
  await link("7", ACCOUNT);
  assert.deepEqual(await risk.run(10n, 20n), { graduated: 0, pulled: 0, devSold: 1 });
  assert.deepEqual(sent.map((s) => s.to), ["7", "group"]);
  assert.match(sent[0]!.text, /⚠️ <b>the \$PEPE dev is selling<\/b>: the address the launchpad names as its deployer, <code>0x0000…00de<\/code>, took <code>0\.4 ETH<\/code> out of the pool/);
  assert.deepEqual(buttons(sent[0]!.keyboard)[0], `s:${TOKEN}:100`);
  // Without the launchpad there is no dev the chain names: nothing.
  const bare = setup({ sales });
  await bare.link("7", ACCOUNT);
  assert.deepEqual(await bare.risk.run(10n, 20n), { graduated: 0, pulled: 0, devSold: 0 });
});

test("a window with nothing new reads nothing; one part failing does not stop the others", async () => {
  const { risk, sent, link } = setup({ pulls: [pull(90n, 10n)] });
  await link("7", ACCOUNT);
  assert.deepEqual(await risk.run(21n, 20n), { graduated: 0, pulled: 0, devSold: 0 });
  const broken = setup({ pulls: [pull(90n, 10n)], launch: async () => { throw new Error("rpc down"); } });
  await broken.link("7", ACCOUNT);
  assert.deepEqual(await broken.risk.run(10n, 20n), { graduated: 0, pulled: 1, devSold: 0 }, "the launchpad down: graduations and dev sales skip, the pull is still told");
  assert.equal(sent.length, 0);
});

test("neon: an alarm is claimed in one insert that does nothing on a key already there", async () => {
  const calls: string[] = [];
  const keys = new Set<string>();
  const sql: RiskSql = { async query(q, params) { calls.push(q); if (q.startsWith("CREATE")) return []; const k = String(params![0]); if (keys.has(k)) return []; keys.add(k); return [{ key: k }]; } };
  const store = new NeonRiskStore(sql);
  assert.equal(await store.claim("liq|4663|0xpool|2026-10-08", clock), true);
  assert.equal(await store.claim("liq|4663|0xpool|2026-10-08", clock), false);
  assert.ok(calls.some((q) => /INSERT INTO bot_risk_told .* ON CONFLICT \(key\) DO NOTHING RETURNING key/.test(q)));
});
