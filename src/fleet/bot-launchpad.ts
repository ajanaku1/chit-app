/**
 * Whether a token is a Pons V2 launch still on its bonding curve (2026-10-06,
 * after SCRAPY). Such a token has no Uniswap pool the bot can trade, and its
 * card warns that it is high risk and not on a Uniswap pool yet. The bot does
 * not trade on the curve: each launch has its own curve contract, which a
 * session cannot name in advance, and the session account's sell only goes
 * through the Uniswap router, so a curve buy could never be sold here.
 *
 * The factory is BOT_LAUNCHPAD_FACTORY (PonsV2LaunchFactory, verified on
 * Sourcify for 4663); its getLaunchedToken names the curve, and the curve's
 * `graduated` says whether it has moved on. A read that fails claims nothing.
 */
import { parseAbi } from "viem";

import type { Address } from "./types.js";

export type LaunchState = { onCurve: true; thresholdWei: bigint } | { onCurve: false };
export type LaunchCheck = (token: Address) => Promise<LaunchState | undefined>;

const FACTORY_ABI = parseAbi([
  "struct Launch { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; }",
  "function getLaunchedToken(address token) view returns (Launch)",
]);
const CURVE_ABI = parseAbi(["function graduated() view returns (bool)"]);

type Read = (args: { address: Address; abi: unknown; functionName: string; args?: unknown[] }) => Promise<unknown>;

export const createLaunchCheck = (p: { factory: Address; readContract: Read }): LaunchCheck => async (token) => {
  try {
    const launch = (await p.readContract({ address: p.factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] })) as { curve: string; graduationThreshold: bigint };
    if (!launch.curve || /^0x0{40}$/i.test(launch.curve)) return undefined;
    const graduated = (await p.readContract({ address: launch.curve as Address, abi: CURVE_ABI, functionName: "graduated" })) as boolean;
    return graduated ? { onCurve: false } : { onCurve: true, thresholdWei: launch.graduationThreshold };
  } catch {
    return undefined;
  }
};
