/**
 * What the mainnet bot reads and sends on a session account: who owns it,
 * the session it granted the bot's key, whether a call would pass, and the
 * `execute` itself, signed by the bot's own key (which pays the gas; the
 * account pays the trade with its own ETH). Nothing of the owner's is held.
 *
 * Sells add two reads and one send: whether the owner turned the sell flag
 * on for the bot's key (`sellAllowed`), whether a sale would pass right now
 * and why not if not (`canSell`: the two checks the contract makes at the
 * top of `sell` asked first, then the contract's own `canSell` view, so the
 * bot's refusal reads like the contract's and costs no gas), and `sell`
 * itself, one call on the account from the bot's key. The account writes
 * the router calldata, so the ETH lands in the account and nowhere else;
 * the Permit2 approvals live inside that one call, for the sale's amount
 * and this block, and are cleared before it returns. Nothing is approved
 * beforehand, nothing is left approved after: a sale is one send.
 *
 * Before that send, two more reads keep a sale that cannot land from costing
 * gas (2026-10-07): whether the token fixes Permit2's allowance at infinity
 * (`permit2Fixed`; such a token refuses the exact approval `sell` makes), and
 * the sale itself as an eth_call from the bot's key (`simulateSell`).
 */

import { type Address, type Hex, type PublicClient, type Transport, type WalletClient, createPublicClient, createWalletClient, decodeErrorResult, http, maxUint256, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TradeReceipt } from "./bot-positions.js";
import { robinhoodChain } from "./chain-def.js";
import { PERMIT2, SESSION_ACCOUNT_ABI, decodeSessionView, encodeSell, encodeSessionExecute, type SessionSell, type SessionView } from "./session-keys.js";
import { NATIVE_ETH, venuePoolKey, type PoolKey } from "./v4-swap.js";

export type SessionChain = {
  chainId: number;
  /** The bot's signer: the key every owner grants a session to. */
  signer: Address;
  ownerOf(account: Address): Promise<Address | undefined>;
  sessionOf(account: Address): Promise<SessionView>;
  /** The contract's own answer: ok, or the reason it would refuse. */
  canExecute(account: Address, target: Address, selector: Hex, value: bigint): Promise<{ ok: boolean; why: string }>;
  /**
   * `execute(target, value, data)` on the account, from the bot's key; the hash once sent, the receipt's status once
   * landed. `receiptWaitMs` caps the wait for this one receipt below the chain's default (RECEIPT_WAIT_MS): a send with
   * less of the request's budget left waits that much and is reported as sent, not landed, when the receipt is slower;
   * zero or less waits for none.
   */
  /** `reverted`: the receipt was seen and it failed, so nothing moved; `landed: false` without it is a receipt not seen in time. */
  execute(account: Address, target: Address, value: bigint, data: Hex, receiptWaitMs?: number): Promise<{ hash: Hex; landed: boolean; reverted?: boolean }>;
  signerBalance(): Promise<bigint>;
  /** Whether the owner let the bot's key sell from this account (`sellAllowed(key)` on the account). */
  sellAllowed(account: Address): Promise<boolean>;
  /**
   * Whether `sell` would pass right now, and why not if not, in the
   * contract's words: the pool has to be an ETH pool of the token and the
   * floor above zero (what `sell` checks first), then `canSell(key, router)`
   * on the account (the flag, then the session and the router rule). The
   * pool key defaults to the venue's for the token, as `sell` does.
   */
  canSell(account: Address, router: Address, poolKey: PoolKey | undefined, amountIn: bigint, minOut: bigint, deadline?: bigint): Promise<{ ok: boolean; why: string }>;
  /** `sell(router, poolKey, amountIn, minOut, deadline)` on the account, from the bot's key: the sale as one call, the ETH into the account. */
  sell(account: Address, sale: SessionSell): Promise<{ hash: Hex; landed: boolean; reverted?: boolean }>;
  /**
   * Whether the token fixes Permit2's allowance at infinity for this account
   * (Solady-style tokens do, for every holder). `sell` approves Permit2 the
   * sale's exact amount and clears it to zero after, and such a token refuses
   * both with Permit2AllowanceIsFixedAtInfinity(), so the session can never
   * sell it: the owner takes it out with withdrawToken instead (2026-10-07,
   * CHOP). A failed read is "no", so the check never blocks a sale on its own.
   */
  permit2Fixed?(token: Address, account: Address): Promise<boolean>;
  /** The sale as an eth_call from the bot's key, before any gas: ok, or the revert in words. A sale that would fail is never sent. Rejects when the chain could not be asked, which is not a verdict. */
  simulateSell?(account: Address, sale: SessionSell): Promise<{ ok: boolean; why: string }>;
  /** A sent trade's receipt: its status, and the token's units that reached the account in it; undefined while there is none (bot-positions.ts). */
  settle?(hash: Hex, token: Address, account: Address): Promise<TradeReceipt>;
  /** Every token the chain shows the account receiving, lowercase, once each: Positions lists what it still holds (bot-positions-card.ts). */
  heldTokens?(account: Address): Promise<Address[]>;
};

/** The widest log query asked for once the whole chain is refused: the public mainnet RPC takes 10 000 000 blocks. */
const LOG_SPAN = 10_000_000n;
const MIN_SPAN = 1_000n;
const MAX_PIECES = 60;

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const ALLOWANCE = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

/** SessionAccount.sol's custom errors, so a simulated revert is named rather than shown as a selector (the SDK's ABI carries no errors). */
const SESSION_ACCOUNT_ERRORS = parseAbi([
  "error NotOwner()", "error NotAuthorized()", "error SessionExists()", "error SessionUnknown()", "error SessionRevokedError()", "error SessionPausedError()",
  "error SessionExpired()", "error RuleNotAllowed()", "error ValueOverCall()", "error ValueOverCap()", "error NoRules()", "error TooManyRules()",
  "error ZeroKey()", "error ZeroTarget()", "error BadExpiry()", "error CallFailed()", "error EmptyCallData()", "error ZeroRecipient()",
  "error WithdrawFailed()", "error Reentered()", "error SellNotAllowed()", "error NotEthPool()", "error NoFloor()", "error SoldTooMuch()", "error ProceedsShort()",
]);

/** Reverts a sale meets, by selector, in words a trader reads; the account's own errors are named from its error list. */
const KNOWN_REVERTS: Record<string, string> = {
  "0x3f68539a": "this token fixes its Permit2 approval at infinity, so it cannot be sold through the session (Permit2AllowanceIsFixedAtInfinity)",
};

/**
 * What an eth_call failed with: `reverted` when the chain itself refused it (revert data found wherever viem nested it, or a
 * message that says reverted), and the failure in words. Anything else (the RPC down, a timeout, a rate limit) is not the
 * chain's verdict on the sale, and `reverted` is false so a caller can tell "would fail" from "could not ask" (2026-10-07).
 */
export const revertOf = (error: unknown): { reverted: boolean; why: string } => {
  let data: string | undefined;
  for (let e = error as { data?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    const d = typeof e.data === "string" ? e.data : (e.data as { data?: unknown } | undefined)?.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) { data = d; break; }
  }
  if (data) {
    const known = KNOWN_REVERTS[data.slice(0, 10).toLowerCase()];
    if (known) return { reverted: true, why: known };
    try { return { reverted: true, why: decodeErrorResult({ abi: SESSION_ACCOUNT_ERRORS, data: data as Hex }).errorName }; } catch { /* not the account's own error */ }
    return { reverted: true, why: `reverted with ${data.slice(0, 10)}` };
  }
  const message = (error as { shortMessage?: string; message?: string } | undefined)?.shortMessage ?? (error as Error | undefined)?.message ?? String(error);
  const why = message.split("\n")[0]!;
  return { reverted: /revert/i.test(why), why };
};

/** The failure in words alone; see revertOf. */
export const revertWords = (error: unknown): string => revertOf(error).why;

/** `receiptWaitMs`: how long one send waits for its receipt before answering with the hash alone; see RECEIPT_WAIT_MS. */
export type SessionChainConfig = { chainId: number; rpcUrl: string; signerKey: Hex; transport?: Transport; receiptWaitMs?: number };

/**
 * The webhook that runs these sends is a function the host stops at sixty
 * seconds (vercel.json, api/bot.js), and a send that outlives it is a trade
 * with no reply and a request Telegram delivers again. So one send waits
 * for its receipt well inside that budget, and the bot makes at most one
 * send per request on its own account; a receipt that takes longer is
 * reported as sent, not confirmed, with the explorer link. The mirrors a
 * leader's buy sets off in the same request are the exception, and they
 * are given only what is left of the request's budget: each waits for its
 * receipt at most that long (`receiptWaitMs` on `execute`), and none is
 * started once the budget is spent (bot-copy.ts, bot-session.ts).
 */
export const RECEIPT_WAIT_MS = 40_000;
const EXECUTE_GAS = 700_000n;
/** A sale is the swap with two approvals made and cleared around it; the fork test sends it with this much. */
export const SELL_GAS = 1_000_000n;

/**
 * The two checks `sell` makes before it asks the session (NotEthPool,
 * NoFloor), in the words the bot uses for them, so a refusal costs no gas
 * and reads the same whoever said it. Null when both pass. Shared with the
 * tests' fake chain so it refuses the way the real one does.
 */
export const sellPreflight = (token: Address, poolKey: PoolKey | undefined, minOut: bigint): string | null => {
  const key = poolKey ?? venuePoolKey(token);
  if (key.currency0 !== NATIVE_ETH || key.currency1 === NATIVE_ETH) return "not an ETH pool";
  if (key.currency1.toLowerCase() !== token.toLowerCase()) return "not this token's pool";
  if (minOut <= 0n) return "no floor";
  return null;
};

export const createSessionChain = (config: SessionChainConfig): SessionChain => {
  const chain = robinhoodChain(config.chainId, config.rpcUrl);
  const transport = config.transport ?? http(config.rpcUrl, { retryCount: 3, retryDelay: 250, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport }) as unknown as PublicClient;
  const account = privateKeyToAccount(config.signerKey);
  const wallet: WalletClient = createWalletClient({ account, chain, transport });
  const receiptWaitMs = config.receiptWaitMs ?? RECEIPT_WAIT_MS;
  /** One send from the bot's key to the account, then the receipt; a wait that runs out, or none asked for, is a hash without a verdict. */
  const send = async (a: Address, data: Hex, gas: bigint, waitMs = receiptWaitMs): Promise<{ hash: Hex; landed: boolean; reverted?: boolean }> => {
    const hash = await wallet.sendTransaction({ account, chain, to: a, data, gas });
    // viem reads a timeout of zero as no timeout at all, so no time left is no wait, said here rather than handed on.
    if (waitMs <= 0) return { hash, landed: false };
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: Math.min(waitMs, receiptWaitMs) });
      return { hash, landed: receipt.status === "success", reverted: receipt.status !== "success" };
    } catch {
      return { hash, landed: false };
    }
  };
  return {
    chainId: config.chainId,
    signer: account.address,
    ownerOf: (a) => pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "owner" }).catch(() => undefined),
    sessionOf: async (a) => decodeSessionView(await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "sessionOf", args: [account.address] })),
    async canExecute(a, target, selector, value) {
      const [ok, why] = await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "canExecute", args: [account.address, target, selector, value] });
      return { ok, why };
    },
    execute: (a, target, value, data, receiptWait) => send(a, encodeSessionExecute(target, value, data), EXECUTE_GAS, receiptWait),
    signerBalance: () => pub.getBalance({ address: account.address }),
    // An account deployed before the flag existed has no `sellAllowed`; the read fails and the answer is no.
    sellAllowed: (a) => pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "sellAllowed", args: [account.address] }).catch(() => false),
    async canSell(a, router, poolKey, _amountIn, minOut) {
      // The pool's token is the sale's token: `sell` reads it from the key it is handed.
      const token = poolKey?.currency1;
      const early = token ? sellPreflight(token, poolKey, minOut) : minOut <= 0n ? "no floor" : null;
      if (early) return { ok: false, why: early };
      // An account without `canSell` is one without `sell`: the answer is the contract's own words for the flag.
      const [ok, why] = await pub.readContract({ address: a, abi: SESSION_ACCOUNT_ABI, functionName: "canSell", args: [account.address, router] }).catch(() => [false, "sell not allowed"] as const);
      return { ok, why };
    },
    sell: (a, sale) => send(a, encodeSell(sale), SELL_GAS),
    permit2Fixed: (token, a) => pub.readContract({ address: token, abi: ALLOWANCE, functionName: "allowance", args: [a, PERMIT2] }).then((v) => v === maxUint256, () => false),
    async simulateSell(a, sale) {
      try {
        await pub.call({ account: account.address, to: a, data: encodeSell(sale), gas: SELL_GAS });
        return { ok: true, why: "" };
      } catch (error) {
        // Only the chain's own refusal is "would fail". An RPC that could not be asked is thrown, and the caller treats it as no simulation at all.
        const r = revertOf(error);
        if (!r.reverted) throw error;
        return { ok: false, why: r.why };
      }
    },
    async heldTokens(a) {
      const tokens = new Set<string>();
      const add = (logs: readonly { address: string }[]) => { for (const l of logs) tokens.add(l.address.toLowerCase()); };
      const ask = (fromBlock: bigint, toBlock: bigint) => pub.getLogs({ event: TRANSFER[0], args: { to: a }, fromBlock, toBlock });
      const head = await pub.getBlockNumber();
      try { add(await ask(0n, head)); return [...tokens] as Address[]; } catch { /* the node would not take the whole chain: pieces, widest first */ }
      let span = LOG_SPAN;
      for (let to = head, asked = 0; to >= 0n && asked < MAX_PIECES; asked++) {
        const from = to - span + 1n > 0n ? to - span + 1n : 0n;
        try { add(await ask(from, to)); to = from - 1n; }
        catch { if (to - from + 1n <= MIN_SPAN) break; span = (to - from + 1n) / 2n; }
      }
      return [...tokens] as Address[];
    },
    async settle(hash, token, a) {
      const receipt = await pub.getTransactionReceipt({ hash }).catch(() => undefined);
      if (!receipt) return undefined;
      const logs = parseEventLogs({ abi: TRANSFER, logs: receipt.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase()) });
      const received = logs.filter((l) => l.args.to.toLowerCase() === a.toLowerCase()).reduce((sum, l) => sum + l.args.value, 0n);
      return { status: receipt.status === "success" ? "success" : "reverted", received };
    },
  };
};
