/**
 * What one trade the bot sends counts against an account's daily gas budget
 * (BOT_DAILY_GAS_ETH): its gas ceiling at a price ceiling. The bot's taps,
 * the copy desk's mirrors and the orders' runner all count with these, so a
 * user's day is one budget whichever of them spends it.
 *
 * The price ceiling was one gwei: about 28 times what Robinhood Chain charges
 * (0.036 gwei measured on 2026-09-26), so the default 0.002 ETH day held three
 * trades. It is now 0.1 gwei, still about three times the chain's price, so a
 * fee spike does not let the bot front more than the budget says. A deploy
 * sets its own with BOT_GAS_PRICE_GWEI (a positive decimal); anything else
 * falls back to the default rather than guessing.
 */

import { parseUnits } from "viem";

/** Gas ceiling of one execute on a session account (a buy, a mirrored buy, a fired order). */
export const EXECUTE_GAS = 700_000n;
/** Gas ceiling of one sell on a session account. */
export const SELL_GAS = 1_000_000n;
/** 0.1 gwei: the price a trade is counted at unless the deploy says otherwise. */
export const DEFAULT_GAS_PRICE_CEILING_WEI = 100_000_000n;

/** The price ceiling, in wei: BOT_GAS_PRICE_GWEI when it is a positive decimal, the default otherwise. */
export const gasPriceCeilingWei = (env: Record<string, string | undefined> = process.env): bigint => {
  const raw = env.BOT_GAS_PRICE_GWEI?.trim();
  if (!raw || !/^\d+(\.\d{1,9})?$/.test(raw)) return DEFAULT_GAS_PRICE_CEILING_WEI;
  const wei = parseUnits(raw, 9);
  return wei > 0n ? wei : DEFAULT_GAS_PRICE_CEILING_WEI;
};

/** What one execute is counted at. */
export const executeGasWei = (price: bigint = gasPriceCeilingWei()): bigint => EXECUTE_GAS * price;
/** What one sell is counted at. */
export const sellGasWei = (price: bigint = gasPriceCeilingWei()): bigint => SELL_GAS * price;
