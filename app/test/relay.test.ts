import assert from "node:assert/strict";
import test from "node:test";

import { OTHER_CHAINS, RelayRefusal, checkQuote, quoteRelay, relayStatus, type QuoteAsk } from "../src/fleet/relay.js";

const USER = "0x186eEd3cE8664965678499903a5A2a0a1f1F8a7F" as const;
const ACCOUNT = "0x42db6078001da1f52706699de65c8beb139041c7" as const;
const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ask: QuoteAsk = { user: USER, recipient: ACCOUNT, fromChain: 8453, toChain: 4663, amountWei: 2_000_000_000_000_000n };

/** The shape Relay answered with for Base to Robinhood Chain on 2026-10-11, cut to what the page reads. */
const relayAnswer = () => ({
  steps: [{
    id: "deposit", action: "Confirm transaction in your wallet", kind: "transaction", requestId: "0x179170855597ecd0a48e3f07e23cecba6f9ec8dd0be0006cbe3cf523ab758486",
    items: [{ status: "incomplete", data: { chainId: 8453, from: USER as string, to: DEPOSITORY, data: "0x49290c1c00", value: "2000000000000000" }, check: { endpoint: "/intents/status?requestId=0x17", method: "GET" } }],
  }],
  details: {
    recipient: ACCOUNT as string, sender: USER as string, timeEstimate: 1,
    currencyIn: { amount: "2000000000000000", currency: { chainId: 8453, address: NATIVE } },
    currencyOut: { amount: "1988859328343689", currency: { chainId: 4663, address: NATIVE } },
  },
});

test("a quote that is what was asked: one deposit from the wallet on the leaving chain, ETH out to the account", () => {
  const q = checkQuote(relayAnswer(), ask);
  assert.equal(q.inWei, 2_000_000_000_000_000n);
  assert.equal(q.outWei, 1_988_859_328_343_689n);
  assert.equal(q.seconds, 1);
  assert.equal(q.requestId, "0x179170855597ecd0a48e3f07e23cecba6f9ec8dd0be0006cbe3cf523ab758486");
  assert.deepEqual(q.txs, [{ chainId: 8453, to: DEPOSITORY, data: "0x49290c1c00", value: 2_000_000_000_000_000n }]);
});

test("anything other than the ask is refused in words before the wallet is asked anything", () => {
  const refused = (mutate: (a: ReturnType<typeof relayAnswer>) => void, why: RegExp) => {
    const a = relayAnswer();
    mutate(a);
    assert.throws(() => checkQuote(a, ask), (e: unknown) => e instanceof RelayRefusal && why.test((e as Error).message));
  };
  refused((a) => { a.details.recipient = "0x00000000000000000000000000000000000000bb"; }, /pays a different address/);
  refused((a) => { a.details.currencyIn.currency.chainId = 1; }, /other than ETH on the chain you picked/);
  refused((a) => { a.details.currencyOut.currency.address = "0x13283ab8e1f2bc4297e9ec6480c80c59674af554"; }, /delivers something other than ETH/);
  refused((a) => { a.details.currencyIn.amount = "3000000000000000"; }, /different amount than you typed/);
  refused((a) => { a.details.currencyOut.amount = "3000000000000000"; }, /amount out makes no sense/);
  refused((a) => { a.steps[0]!.kind = "signature"; }, /kind of signature/);
  refused((a) => { a.steps[0]!.items[0]!.data.from = "0x00000000000000000000000000000000000000cc"; }, /not one your wallet sends/);
  refused((a) => { a.steps[0]!.items[0]!.data.chainId = 42161; }, /not one your wallet sends/);
  refused((a) => { a.steps[0]!.items[0]!.data.value = "2500000000000000"; }, /different amount of ETH/);
  refused((a) => { a.steps = []; }, /no route/);
  refused((a) => { a.steps[0]!.requestId = ""; }, /no request to follow/);
  // The recipient is compared without case, as addresses are.
  const mixed = relayAnswer();
  mixed.details.recipient = ACCOUNT.toUpperCase().replace("0X", "0x");
  assert.equal(checkQuote(mixed, ask).outWei, 1_988_859_328_343_689n);
});

test("the ask goes to Relay as ETH to ETH, exact input, the amount in wei; a refusal carries Relay's own words", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const ok = async (url: string, init?: { body?: string }) => { calls.push({ url, body: JSON.parse(init?.body ?? "{}") }); return { ok: true, status: 200, json: async () => relayAnswer() }; };
  const q = await quoteRelay(ask, ok);
  assert.equal(q.txs.length, 1);
  assert.equal(calls[0]!.url, "https://api.relay.link/quote");
  assert.deepEqual(calls[0]!.body, { user: USER, recipient: ACCOUNT, originChainId: 8453, destinationChainId: 4663, originCurrency: NATIVE, destinationCurrency: NATIVE, amount: "2000000000000000", tradeType: "EXACT_INPUT" });
  const no = async () => ({ ok: false, status: 400, json: async () => ({ message: "Amount is too low" }) });
  await assert.rejects(quoteRelay(ask, no), (e: unknown) => e instanceof RelayRefusal && /Amount is too low/.test((e as Error).message));
});

test("a request's state is Relay's word, and a read that fails is unknown, never failure", async () => {
  const says = (status: string) => async () => ({ ok: true, status: 200, json: async () => ({ status }) });
  assert.equal(await relayStatus("0x01", says("success")), "success");
  assert.equal(await relayStatus("0x01", says("refund")), "refund");
  assert.equal(await relayStatus("0x01", says("something-new")), "unknown");
  assert.equal(await relayStatus("0x01", async () => { throw new Error("offline"); }), "unknown");
  assert.equal(await relayStatus("0x01", async () => ({ ok: false, status: 502, json: async () => ({}) })), "unknown");
});

test("the chains offered are the ones Relay serves next to Robinhood Chain, each a wallet can switch to", () => {
  assert.deepEqual(OTHER_CHAINS.map((c) => c.id), [8453, 42161, 1]);
  for (const c of OTHER_CHAINS) if (c.add) assert.equal(BigInt(c.add.chainId), BigInt(c.id));
});
