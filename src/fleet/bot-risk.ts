/**
 * The watcher's second reader: what can hurt a holder, read from the same
 * block window the buys were read from (bot-watch.ts), told once.
 *
 * Three events, each read from logs the chain wrote and nothing else:
 *
 * - A graduation: a launchpad token (BOT_LAUNCHPAD_FACTORY, Pons V2) whose
 *   curve is done gets its Uniswap pool, an Initialize log with ETH as
 *   currency0. The factory names the token's curve and the curve says it
 *   graduated; a pool opened for any other token is not a graduation. Told
 *   once per token, ever: to the alert subscribers, then the group, with the
 *   door into the token card, because from now on the bot can trade it.
 * - Liquidity pulled: in the pool the bot trades a held token through (the
 *   registry's, as the card's), liquidity taken out of the range the price
 *   sits in, at least `pulledPct` (half by default) of what was there, in
 *   one transaction. Liquidity out of range is not what a sale meets and is
 *   not counted. Told once per pool per UTC day.
 * - The dev selling: the address the launchpad names as a launch's deployer
 *   sending a transaction that took ETH out of the token's pool, at least
 *   `devSellMinWei`. Only launchpad tokens have a dev the chain names; any
 *   other token's creator is not guessed. Told once per token per UTC day.
 *
 * "Held" is what the bot's own trade record knows: the tokens its users
 * bought through it in the last thirty days (bot-positions.ts), and for an
 * alarm, the accounts that traded the token and still hold some, read now.
 * Those holders are told first, privately, with 🚪 Sell 100% (the session
 * bot's own sell, so a tap is a sale from their account) and the card; the
 * group is told after them, with the card only, a sale being nobody's to
 * tap from a group. An exit is never held back by the $CHIT holders line.
 *
 * Every alarm is claimed in the store before anyone is told, in one
 * statement, so two passes over one window tell it once; a pass cut off
 * after the claim loses the alarm rather than repeating it. A read that
 * fails is a log line and the next event; nothing here sends a
 * transaction or reads a key.
 */

import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient, type Transport } from "viem";
import type { BotChain } from "./bot-chain.js";
import type { BotLinkStore } from "./bot-link.js";
import type { AlertStore } from "./bot-alerts.js";
import { esc, type Keyboard } from "./bot-telegram.js";
import { robinhoodChain } from "./chain-def.js";
import { decodeSlot0, liquiditySlot, slot0Slot } from "./market.js";
import { createPoolRegistry, type PoolRegistry } from "./pool-registry.js";
import type { PoolKey } from "./v4-swap.js";

export type Graduation = { token: Address; poolId: Hex; txHash: Hex; block: bigint };
/** In-range liquidity one transaction took out of a pool, beside what the range still holds after the window. */
export type Pull = { token: Address; poolId: Hex; txHash: Hex; block: bigint; by: Address; removed: bigint; left: bigint };
/** ETH one transaction took out of a pool, by its sender. */
export type Sale = { token: Address; poolId: Hex; txHash: Hex; block: bigint; by: Address; ethOutWei: bigint };

export type RiskPort = {
  /** ETH pools opened in [from, to]: the token is currency1. */
  opened(from: bigint, to: bigint): Promise<Graduation[]>;
  /** The pool each token trades through (the registry's), or none. */
  poolOf(token: Address): Promise<Hex | undefined>;
  pulls(from: bigint, to: bigint, pools: Map<string, Address>): Promise<Pull[]>;
  /** Transactions that took at least `minEthWei` out of these pools, each with its sender. */
  sales(from: bigint, to: bigint, pools: Map<string, Address>, minEthWei: bigint): Promise<Sale[]>;
};

/** A launchpad token as its factory names it; undefined for any other token or a read that failed. */
export type LaunchInfo = (token: Address) => Promise<{ deployer: Address; graduated: boolean } | undefined>;

export interface RiskStore {
  /** One statement: true when this alarm was not claimed and now is. */
  claim(key: string, at: Date): Promise<boolean>;
}

export type RiskDeps = {
  port: RiskPort;
  store: RiskStore;
  chainId: number;
  reads: Pick<BotChain, "tokenInfo" | "tokenBalance">;
  links: Pick<BotLinkStore, "linksTo">;
  /** The tokens the bot's users traded lately, and the accounts that traded one (bot-positions.ts). */
  held: { tokens(): Promise<Address[]>; accounts(token: Address): Promise<Address[]> };
  /** The alert subscribers (bot-alerts.ts), told of a graduation before the group. */
  subs: Pick<AlertStore, "active">;
  launch?: LaunchInfo;
  tell: (tgId: string, text: string, keyboard?: Keyboard) => Promise<void>;
  feed?: { post(text: string, keyboard: Keyboard): Promise<void> };
  botUsername: string;
  /** Share of the in-range liquidity one transaction must take out to be an alarm; default 50. */
  pulledPct?: number;
  /** ETH a dev's sale must take out to be an alarm; default 0.05. */
  devSellMinWei?: bigint;
  now?: () => Date;
};

export type RiskRun = { graduated: number; pulled: number; devSold: number };

export const DEFAULT_PULLED_PCT = 50;
export const DEFAULT_DEV_SELL_MIN_WEI = 5n * 10n ** 16n;

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint): string => {
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return `${w}${f ? "." + f : ""}`;
};
const tx = (h: Hex): string => `<a href="https://robinhoodchain.blockscout.com/tx/${h}">${h.slice(0, 10)}…</a>`;
const lower = (a: string): Address => a.toLowerCase() as Address;

export class RiskWatch {
  readonly #d: RiskDeps;
  constructor(d: RiskDeps) { this.#d = d; }
  get #now(): Date { return this.#d.now ? this.#d.now() : new Date(); }
  #day(): string { return this.#now.toISOString().slice(0, 10); }
  #card(token: Address): Keyboard[number] { return [{ text: "open the card", url: `https://t.me/${this.#d.botUsername}?start=t-${token}` }]; }

  async #symbol(token: Address): Promise<string> {
    const info = await this.#d.reads.tokenInfo(token).catch(() => undefined);
    return info?.symbol && info.symbol !== "?" ? `$${esc(info.symbol)}` : short(token);
  }

  /** One window: graduations, then pulls and dev sales in the pools of held tokens. Each part caught on its own. */
  async run(from: bigint, to: bigint): Promise<RiskRun> {
    const out: RiskRun = { graduated: 0, pulled: 0, devSold: 0 };
    if (from > to) return out;
    const step = async (name: string, f: () => Promise<void>) => f().catch((e: unknown) => console.error(`bot risk: ${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`));
    await step("graduations", async () => { out.graduated = await this.#graduations(from, to); });
    const pools = new Map<string, Address>();
    await step("held pools", async () => {
      for (const t of await this.#d.held.tokens()) {
        const id = await this.#d.port.poolOf(t).catch(() => undefined);
        if (id) pools.set(id.toLowerCase(), lower(t));
      }
    });
    if (!pools.size) return out;
    await step("pulls", async () => { out.pulled = await this.#pulls(from, to, pools); });
    await step("dev sales", async () => { out.devSold = await this.#devSales(from, to, pools); });
    return out;
  }

  async #graduations(from: bigint, to: bigint): Promise<number> {
    if (!this.#d.launch) return 0;
    let told = 0;
    for (const g of await this.#d.port.opened(from, to)) {
      const launch = await this.#d.launch(g.token).catch(() => undefined);
      if (!launch?.graduated) continue;
      if (!(await this.#d.store.claim(`grad|${this.#d.chainId}|${lower(g.token)}`, this.#now))) continue;
      const what = await this.#symbol(g.token);
      const text = [
        `🎓 <b>${what} graduated</b>: its launchpad curve is done and its Uniswap pool just opened · ${tx(g.txHash)}`,
        "the bot can trade it from here, the same one tap as any token. read the card's orus line before you buy; a new pool is thin.",
        `<i>read from the chain: the pool manager's Initialize log and the launchpad's own curve. the address is <code>${g.token}</code>.</i>`,
      ].join("\n");
      // Holders first: the subscribers, privately, then the group.
      for (const s of await this.#d.subs.active()) await this.#d.tell(s.tgId, text, [this.#card(g.token)]).catch((e: unknown) => console.error(`bot risk: dm ${s.tgId}: ${String(e)}`));
      await this.#d.feed?.post(text, [this.#card(g.token)]).catch((e: unknown) => console.error(`bot risk: group: ${String(e)}`));
      told += 1;
    }
    return told;
  }

  async #pulls(from: bigint, to: bigint, pools: Map<string, Address>): Promise<number> {
    const min = BigInt(this.#d.pulledPct ?? DEFAULT_PULLED_PCT);
    let told = 0;
    for (const p of await this.#d.port.pulls(from, to, pools)) {
      const before = p.removed + p.left;
      if (before === 0n || p.removed * 100n < before * min) continue;
      if (!(await this.#d.store.claim(`liq|${this.#d.chainId}|${p.poolId.toLowerCase()}|${this.#day()}`, this.#now))) continue;
      const pct = Number((p.removed * 100n) / before);
      const what = await this.#symbol(p.token);
      await this.#alarm(p.token, [
        `🚨 <b>liquidity pulled from ${what}</b>: ${pct}% of what sat at the price left the pool in one transaction, sent by <code>${short(p.by)}</code> · ${tx(p.txHash)}`,
        "the price can fall fast now and a sale meets less on the other side.",
      ]);
      told += 1;
    }
    return told;
  }

  async #devSales(from: bigint, to: bigint, pools: Map<string, Address>): Promise<number> {
    if (!this.#d.launch) return 0;
    const min = this.#d.devSellMinWei ?? DEFAULT_DEV_SELL_MIN_WEI;
    const devs = new Map<string, Address>();
    for (const token of new Set(pools.values())) {
      const launch = await this.#d.launch(token).catch(() => undefined);
      if (launch) devs.set(token, lower(launch.deployer));
    }
    // Only the pools of tokens with a dev the chain names, and only sales big enough to matter, have their senders read.
    const devPools = new Map([...pools].filter(([, token]) => devs.has(token)));
    if (!devPools.size) return 0;
    let told = 0;
    for (const s of await this.#d.port.sales(from, to, devPools, min)) {
      if (devs.get(lower(s.token)) !== lower(s.by) || s.ethOutWei < min) continue;
      if (!(await this.#d.store.claim(`dev|${this.#d.chainId}|${lower(s.token)}|${this.#day()}`, this.#now))) continue;
      const what = await this.#symbol(s.token);
      await this.#alarm(s.token, [
        `⚠️ <b>the ${what} dev is selling</b>: the address the launchpad names as its deployer, <code>${short(s.by)}</code>, took <code>${eth(s.ethOutWei)} ETH</code> out of the pool · ${tx(s.txHash)}`,
        "a dev selling is not always the end, but it is the first thing to know.",
      ]);
      told += 1;
    }
    return told;
  }

  /** The accounts that traded the token and hold some now, privately and first, with the exit; then the group, with the card. */
  async #alarm(token: Address, lines: string[]): Promise<void> {
    const foot = `<i>read from the chain (the pool manager's logs), not from us. the address is <code>${token}</code>.</i>`;
    const told = new Set<string>();
    for (const account of await this.#d.held.accounts(token)) {
      const held = await this.#d.reads.tokenBalance(token, account).catch(() => 0n);
      if (held <= 0n) continue;
      for (const link of await this.#d.links.linksTo(account).catch(() => [])) {
        if (told.has(link.tgId)) continue;
        told.add(link.tgId);
        await this.#d.tell(link.tgId, [...lines, "your account still holds some. one tap sells all of it from your account:", foot].join("\n"), [[{ text: "🚪 Sell 100%", callback_data: `s:${token}:100` }], this.#card(token)])
          .catch((e: unknown) => console.error(`bot risk: dm ${link.tgId}: ${String(e)}`));
      }
    }
    await this.#d.feed?.post([...lines, foot].join("\n"), [this.#card(token)]).catch((e: unknown) => console.error(`bot risk: group: ${String(e)}`));
  }
}

// ---------- the stores ----------

export class MemoryRiskStore implements RiskStore {
  readonly keys = new Map<string, string>();
  async claim(key: string, at: Date) {
    if (this.keys.has(key)) return false;
    this.keys.set(key, at.toISOString());
    return true;
  }
}

export type RiskSql = { query(sql: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]> };

export class NeonRiskStore implements RiskStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: RiskSql) {}
  #init(): Promise<void> { return (this.#ready ??= this.sql.query(`CREATE TABLE IF NOT EXISTS bot_risk_told (key TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL)`).then(() => undefined).catch((e) => { this.#ready = undefined; throw e; })); }
  async claim(key: string, at: Date) {
    await this.#init();
    return (await this.sql.query(`INSERT INTO bot_risk_told (key, at) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, at.toISOString()])).length === 1;
  }
}

// ---------- the launchpad ----------

const FACTORY_ABI = parseAbi([
  "struct Launch { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; }",
  "function getLaunchedToken(address token) view returns (Launch)",
]);
const CURVE_ABI = parseAbi(["function graduated() view returns (bool)"]);
type Read = (args: { address: Address; abi: unknown; functionName: string; args?: unknown[] }) => Promise<unknown>;

/** The factory's word on a token (bot-launchpad.ts reads the same two calls for the card's curve warning). */
export const createLaunchInfo = (p: { factory: Address; readContract: Read }): LaunchInfo => async (token) => {
  try {
    const launch = (await p.readContract({ address: p.factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] })) as { curve: string; deployer: string };
    if (!launch.curve || /^0x0{40}$/i.test(launch.curve)) return undefined;
    const graduated = (await p.readContract({ address: launch.curve as Address, abi: CURVE_ABI, functionName: "graduated" })) as boolean;
    return { deployer: launch.deployer as Address, graduated };
  } catch {
    return undefined;
  }
};

// ---------- the port ----------

const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const MODIFY = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");
const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const EXTSLOAD = parseAbi(["function extsload(bytes32[] slots) view returns (bytes32[])"]);
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const LOG_SPAN = 100_000n;

export type RiskPortConfig = { chainId: number; rpcUrl: string; poolManager: Address; recordedPools?: PoolKey[]; registry?: PoolRegistry; transport?: Transport };

export const createRiskPort = (config: RiskPortConfig): RiskPort => {
  const transport = config.transport ?? http(config.rpcUrl, { retryCount: 4, retryDelay: 600, timeout: 20_000 });
  const client = createPublicClient({ chain: robinhoodChain(config.chainId, config.rpcUrl), transport }) as unknown as PublicClient;
  const registry = config.registry ?? createPoolRegistry(client, config.poolManager, { chainId: config.chainId, ...(config.recordedPools ? { recorded: config.recordedPools } : {}) });
  const spans = (from: bigint, to: bigint): Array<[bigint, bigint]> => {
    const out: Array<[bigint, bigint]> = [];
    for (let s = from; s <= to; s += LOG_SPAN) out.push([s, s + LOG_SPAN - 1n < to ? s + LOG_SPAN - 1n : to]);
    return out;
  };
  const senders = new Map<string, Address>();
  const senderOf = async (hash: Hex): Promise<Address> => {
    const have = senders.get(hash.toLowerCase());
    if (have) return have;
    const t = await client.getTransaction({ hash });
    if (senders.size > 5_000) senders.clear();
    senders.set(hash.toLowerCase(), t.from);
    return t.from;
  };
  return {
    async opened(from, to) {
      const out: Graduation[] = [];
      for (const [a, b] of spans(from, to)) {
        const logs = await client.getLogs({ address: config.poolManager, event: INITIALIZE, args: { currency0: NATIVE }, fromBlock: a, toBlock: b });
        for (const l of logs) if (l.args.id && l.args.currency1 && l.transactionHash && l.blockNumber !== null) out.push({ token: lower(l.args.currency1), poolId: l.args.id, txHash: l.transactionHash, block: l.blockNumber });
      }
      return out;
    },
    async poolOf(token) { return (await registry.find(token))?.id; },
    async pulls(from, to, pools) {
      const ids = [...pools.keys()] as Hex[];
      const removed = new Map<string, { token: Address; poolId: Hex; txHash: Hex; block: bigint; lower: number; upper: number; delta: bigint }[]>();
      for (const [a, b] of spans(from, to)) {
        const logs = await client.getLogs({ address: config.poolManager, event: MODIFY, args: { id: ids }, fromBlock: a, toBlock: b });
        for (const l of logs) {
          const { id, tickLower, tickUpper, liquidityDelta } = l.args;
          if (!id || liquidityDelta === undefined || liquidityDelta >= 0n || tickLower === undefined || tickUpper === undefined || !l.transactionHash || l.blockNumber === null) continue;
          const key = id.toLowerCase();
          removed.set(key, [...(removed.get(key) ?? []), { token: pools.get(key)!, poolId: id, txHash: l.transactionHash, block: l.blockNumber, lower: tickLower, upper: tickUpper, delta: -liquidityDelta }]);
        }
      }
      const out: Pull[] = [];
      for (const [key, rows] of removed) {
        // The range the price sits in now, and the liquidity left in it: only what a sale meets is counted.
        const [slot0, liq] = await client.readContract({ address: config.poolManager, abi: EXTSLOAD, functionName: "extsload", args: [[slot0Slot(key as Hex), liquiditySlot(key as Hex)]] });
        const tick = decodeSlot0(slot0!).tick;
        const left = BigInt(liq!) & ((1n << 128n) - 1n);
        const byTx = new Map<string, { row: (typeof rows)[number]; removed: bigint }>();
        for (const r of rows) {
          if (!(r.lower <= tick && tick < r.upper)) continue;
          const have = byTx.get(r.txHash.toLowerCase());
          if (have) have.removed += r.delta; else byTx.set(r.txHash.toLowerCase(), { row: r, removed: r.delta });
        }
        for (const { row, removed: amount } of byTx.values()) out.push({ token: row.token, poolId: row.poolId, txHash: row.txHash, block: row.block, by: await senderOf(row.txHash), removed: amount, left });
      }
      return out;
    },
    async sales(from, to, pools, minEthWei) {
      const ids = [...pools.keys()] as Hex[];
      const net = new Map<string, { token: Address; poolId: Hex; txHash: Hex; block: bigint; eth: bigint }>();
      for (const [a, b] of spans(from, to)) {
        const logs = await client.getLogs({ address: config.poolManager, event: SWAP, args: { id: ids }, fromBlock: a, toBlock: b });
        for (const l of logs) {
          const { id, amount0 } = l.args;
          if (!id || amount0 === undefined || !l.transactionHash || l.blockNumber === null) continue;
          // v4's deltas are the swapper's: amount0 positive is ETH the swapper took out.
          const key = `${l.transactionHash.toLowerCase()}|${id.toLowerCase()}`;
          const have = net.get(key);
          if (have) have.eth += amount0; else net.set(key, { token: pools.get(id.toLowerCase())!, poolId: id, txHash: l.transactionHash, block: l.blockNumber, eth: amount0 });
        }
      }
      const out: Sale[] = [];
      for (const n of net.values()) if (n.eth > 0n && n.eth >= minEthWei) out.push({ token: n.token, poolId: n.poolId, txHash: n.txHash, block: n.block, by: await senderOf(n.txHash), ethOutWei: n.eth });
      return out;
    },
  };
};
