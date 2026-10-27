/**
 * The sentence desk's one question (specs/006 US2, FR-007, FR-012a): when a
 * draft misses its token, its size, its direction or a DCA interval, the bot
 * asks with buttons and never guesses. What a question offers and how an
 * answer fills the draft live here; nothing here sends or stores.
 */

import type { Proposal } from "./bot-sentence-translate.js";

export type Missing = "token" | "size" | "direction" | "interval";
/** What the question says, its button labels, and the value each button puts into the draft. */
export type Ask = { missing: Missing; text: string; labels: string[]; choices: string[] };
/** The proposals so far and, once the token question is answered, the token it picked. */
export type Draft = { proposals: Proposal[]; pinned?: string };

export const SELL_SIZES = [25, 50, 100] as const;
export const BUY_SIZES = ["0.005", "0.01", "0.05"] as const;
const EVERY = ["hourly", "daily", "weekly"] as const;
const isExit = (p: Proposal): boolean => p.kind === "tp" || p.kind === "sl";
const isBuy = (p: Proposal): boolean => p.kind === "limit" || p.kind === "dca";

/** The size or interval a draft still needs before it can be a card; the token and the direction are asked elsewhere. */
export const gap = (proposals: Proposal[]): { missing: "size"; sell: boolean } | { missing: "interval" } | undefined => {
  if (proposals.some((p) => isExit(p) && !p.size)) return { missing: "size", sell: true };
  if (proposals.some((p) => isBuy(p) && !(p.size && "eth" in p.size))) return { missing: "size", sell: false };
  if (proposals.some((p) => p.kind === "dca" && !p.every)) return { missing: "interval" };
  return undefined;
};

export const tokenAsk = (options: { symbol: string; address: string }[]): Ask => {
  const shown = options.slice(0, 4);
  const one = shown.every((o) => o.symbol === shown[0]?.symbol);
  return {
    missing: "token",
    text: one ? `which ${shown[0]?.symbol ?? "token"}? the account holds more than one.` : "which token?",
    labels: shown.map((o) => `${o.symbol} …${o.address.slice(-4)}`),
    choices: shown.map((o) => o.address),
  };
};

export const sizeAsk = (sell: boolean, symbol: string): Ask => sell
  ? { missing: "size", text: `how much of your ${symbol}?`, labels: SELL_SIZES.map((n) => `${n}%`), choices: SELL_SIZES.map((n) => `pct:${n}`) }
  : { missing: "size", text: `how much ETH into ${symbol}?`, labels: BUY_SIZES.map((e) => `${e} ETH`), choices: BUY_SIZES.map((e) => `eth:${e}`) };

/** Take profit or stop loss at the move the sentence named; undefined when it named none to offer. */
export const directionAsk = (draft: Proposal[]): Ask | undefined => {
  const level = draft.find((p) => p.level)?.level;
  const n = level && "percent" in level ? Math.abs(level.percent) : level && "multiple" in level ? Math.round(Math.abs(level.multiple - 1) * 100) : undefined;
  if (!n) return undefined;
  return { missing: "direction", text: "take profit or stop loss?", labels: [`take profit at +${n}%`, `stop loss at −${n}%`], choices: ["tp", "sl"] };
};

export const intervalAsk = (): Ask => ({ missing: "interval", text: "how often?", labels: [...EVERY], choices: [...EVERY] });

/** A sell share left unsaid after the direction answer is all of it, said on the card (IMPLEMENTATION.md, 2026-10-22). */
export const ALL_OF_IT = "no share was given, so all of it. Cancel and say a share to sell less.";

/** The move the direction question offered, as a percent signed by the answer: a multiple of 2 is +100% or -100% alike. */
const signed = (p: Proposal, up: boolean): Pick<Proposal, "level"> => {
  const l = p.level;
  if (!l || !("multiple" in l || "percent" in l)) return {};
  const n = "percent" in l ? Math.abs(l.percent) : Math.round(Math.abs(l.multiple - 1) * 100);
  return { level: { percent: up ? n : -n } };
};

/** The draft with the tapped answer in it. */
export const apply = (draft: Draft, missing: Missing, choice: string): Draft => {
  if (missing === "token") return { ...draft, pinned: choice };
  const proposals = draft.proposals.map((p): Proposal => {
    if (missing === "direction") return isExit(p) ? { ...p, kind: choice as "tp" | "sl", ...signed(p, choice === "tp"), ...(p.size ? {} : { size: { pct: 100 }, note: ALL_OF_IT }) } : p;
    if (missing === "interval") return p.kind === "dca" && !p.every ? { ...p, every: choice as (typeof EVERY)[number] } : p;
    const [unit, value = ""] = choice.split(":");
    if (unit === "pct" && isExit(p) && !p.size) return { ...p, size: { pct: Number(value) } };
    if (unit === "eth" && isBuy(p) && !(p.size && "eth" in p.size)) return { ...p, size: { eth: value } };
    return p;
  });
  return { ...draft, proposals };
};
