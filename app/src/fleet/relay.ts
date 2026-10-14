/**
 * ETH between Robinhood Chain and the chains people already hold it on,
 * through Relay (relay.link): no bridge for the person to run, one
 * transaction from their wallet on the chain the ETH leaves, and it lands
 * where they said.
 *
 * Relay writes the transaction; this page does not take it on trust. A quote
 * is used only when it is exactly what was asked for: ETH in on the chain it
 * leaves, ETH out on the chain it goes to, paid to the recipient asked for,
 * the amount asked for, and every transaction on the leaving chain from the
 * wallet signing it and sending, in all, that amount and nothing more.
 * Anything else is refused in words before the wallet is asked anything.
 *
 * $CHIT does not move: this is ETH only, into and out of the session
 * account. Robinhood Chain stays the one chain the token and the burn live
 * on.
 */

export type Hex = `0x${string}`;

export const RELAY_API = "https://api.relay.link";
const NATIVE = "0x0000000000000000000000000000000000000000";

/** A chain ETH can come from or go to, with what a wallet needs to add it when it does not know it. */
export type OtherChain = { id: number; name: string; add?: { chainId: Hex; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] } };

const ether = { name: "Ether", symbol: "ETH", decimals: 18 };
export const OTHER_CHAINS: readonly OtherChain[] = [
  { id: 8453, name: "Base", add: { chainId: "0x2105", chainName: "Base", nativeCurrency: ether, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] } },
  { id: 42161, name: "Arbitrum", add: { chainId: "0xa4b1", chainName: "Arbitrum One", nativeCurrency: ether, rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"] } },
  { id: 1, name: "Ethereum" },
];

/** Relay routes to Robinhood Chain mainnet (4663) only; a testnet host shows none of this. */
export const RELAY_HOME_CHAIN = 4663;

export type RelayTx = { chainId: number; to: Hex; data: Hex; value: bigint };
export type RelayQuote = { requestId: string; txs: RelayTx[]; inWei: bigint; outWei: bigint; seconds: number };
export type QuoteAsk = { user: Hex; recipient: Hex; fromChain: number; toChain: number; amountWei: bigint };

export class RelayRefusal extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const big = (s: unknown): bigint => {
  try { return BigInt(String(s)); } catch { throw new RelayRefusal("the quote carried an amount that is not a number"); }
};

/** The quote, checked against the ask. Throws a RelayRefusal saying what did not match. */
export const checkQuote = (body: unknown, ask: QuoteAsk): RelayQuote => {
  const q = body as {
    steps?: { kind?: string; requestId?: string; items?: { data?: { chainId?: number; from?: string; to?: string; data?: string; value?: string } }[] }[];
    details?: { recipient?: string; timeEstimate?: number; currencyIn?: { amount?: string; currency?: { chainId?: number; address?: string } }; currencyOut?: { amount?: string; currency?: { chainId?: number; address?: string } } };
  };
  const d = q?.details;
  if (!d || !Array.isArray(q.steps) || !q.steps.length) throw new RelayRefusal("Relay sent no route for this");
  if (lower(d.recipient) !== lower(ask.recipient)) throw new RelayRefusal("the quote pays a different address than yours, so it was not used");
  if (d.currencyIn?.currency?.chainId !== ask.fromChain || lower(d.currencyIn.currency.address) !== NATIVE) throw new RelayRefusal("the quote takes something other than ETH on the chain you picked");
  if (d.currencyOut?.currency?.chainId !== ask.toChain || lower(d.currencyOut.currency.address) !== NATIVE) throw new RelayRefusal("the quote delivers something other than ETH where you asked");
  const inWei = big(d.currencyIn.amount);
  const outWei = big(d.currencyOut.amount);
  if (inWei !== ask.amountWei) throw new RelayRefusal("the quote is for a different amount than you typed");
  if (outWei <= 0n || outWei > inWei) throw new RelayRefusal("the quote's amount out makes no sense");
  const txs: RelayTx[] = [];
  for (const step of q.steps) {
    // Only transactions: a step asking for a signature over a message is not something this page signs.
    if (step.kind !== "transaction") throw new RelayRefusal("the route needs a kind of signature this page does not ask for");
    for (const item of step.items ?? []) {
      const t = item.data;
      if (!t || t.chainId !== ask.fromChain || lower(t.from) !== lower(ask.user) || !/^0x[0-9a-fA-F]{40}$/.test(String(t.to))) throw new RelayRefusal("a transaction in the route is not one your wallet sends on the chain you picked");
      txs.push({ chainId: t.chainId, to: t.to as Hex, data: (t.data && /^0x[0-9a-fA-F]*$/.test(t.data) ? t.data : "0x") as Hex, value: big(t.value ?? "0") });
    }
  }
  if (!txs.length) throw new RelayRefusal("Relay sent no transaction for this");
  const sent = txs.reduce((s, t) => s + t.value, 0n);
  if (sent !== ask.amountWei) throw new RelayRefusal("the route would send a different amount of ETH than you typed");
  const requestId = q.steps[0]!.requestId;
  if (!requestId || !/^0x[0-9a-fA-F]+$/.test(requestId)) throw new RelayRefusal("the quote has no request to follow");
  return { requestId, txs, inWei, outWei, seconds: Number(d.timeEstimate ?? 0) || 0 };
};

export const quoteRelay = async (ask: QuoteAsk, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<RelayQuote> => {
  const res = await fetchImpl(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: ask.user, recipient: ask.recipient, originChainId: ask.fromChain, destinationChainId: ask.toChain, originCurrency: NATIVE, destinationCurrency: NATIVE, amount: ask.amountWei.toString(), tradeType: "EXACT_INPUT" }),
  });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new RelayRefusal((body as { message?: string } | undefined)?.message ?? `Relay answered ${res.status}`);
  return checkQuote(body, ask);
};

export type RelayState = "waiting" | "pending" | "success" | "failure" | "refund" | "unknown";

/** Where a request stands; a read that fails is unknown, never failure. */
export const relayStatus = async (requestId: string, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<RelayState> => {
  try {
    const res = await fetchImpl(`${RELAY_API}/intents/status?requestId=${encodeURIComponent(requestId)}`);
    if (!res.ok) return "unknown";
    const s = String(((await res.json()) as { status?: string }).status ?? "");
    return (["waiting", "pending", "success", "failure", "refund"] as const).find((x) => x === s) ?? "unknown";
  } catch {
    return "unknown";
  }
};
