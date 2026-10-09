/**
 * Where a discovered pool is kept between instances. Finding a token's ETH
 * pool is a scan of the pool manager's openings over the whole chain, and the
 * public RPC refuses that above 19 500 blocks, so the scan walks sixty pieces
 * at ~290 ms each: twenty seconds, paid again by every new function instance
 * for every token it touches (pool-registry.ts). A pool found once is kept
 * here by chain and token, so the next instance reads one row instead.
 *
 * Only a found pool is kept: a token with none today may open one tomorrow,
 * and a kept pool that has gone dry is scanned for again (pool-registry.ts).
 */
import type { CompSql } from "./bot-comp.js";
import type { PoolKey } from "./v4-swap.js";
import type { Address } from "./types.js";

export type PoolStore = {
  get(chainId: number, token: Address): Promise<PoolKey | undefined>;
  put(chainId: number, token: Address, key: PoolKey): Promise<void>;
};

export class MemoryPoolStore implements PoolStore {
  readonly kept = new Map<string, PoolKey>();
  async get(chainId: number, token: Address) { return this.kept.get(`${chainId}:${token.toLowerCase()}`); }
  async put(chainId: number, token: Address, key: PoolKey) { this.kept.set(`${chainId}:${token.toLowerCase()}`, key); }
}

export class NeonPoolStore implements PoolStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: CompSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= this.sql.query(`CREATE TABLE IF NOT EXISTS bot_pools (chain_id INTEGER NOT NULL, token TEXT NOT NULL, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL, fee INTEGER NOT NULL, tick_spacing INTEGER NOT NULL, hooks TEXT NOT NULL, found_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (chain_id, token))`).then(() => undefined).catch((e) => { this.#ready = undefined; throw e; }));
  }
  async get(chainId: number, token: Address): Promise<PoolKey | undefined> {
    await this.#init();
    const [r] = await this.sql.query(`SELECT currency0, currency1, fee, tick_spacing, hooks FROM bot_pools WHERE chain_id = $1 AND token = $2`, [chainId, token.toLowerCase()]);
    return r ? { currency0: r.currency0 as Address, currency1: r.currency1 as Address, fee: Number(r.fee), tickSpacing: Number(r.tick_spacing), hooks: r.hooks as Address } : undefined;
  }
  async put(chainId: number, token: Address, key: PoolKey): Promise<void> {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_pools (chain_id, token, currency0, currency1, fee, tick_spacing, hooks) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (chain_id, token) DO UPDATE SET currency0 = EXCLUDED.currency0, currency1 = EXCLUDED.currency1, fee = EXCLUDED.fee, tick_spacing = EXCLUDED.tick_spacing, hooks = EXCLUDED.hooks, found_at = NOW()`, [chainId, token.toLowerCase(), key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
  }
}
