import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { custom, parseAbi, parseEther, type Address } from "viem";

import { createBotChain, minOutFor } from "../../src/fleet/bot-chain.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { MemoryOrderStore, OrderRunner } from "../../src/fleet/bot-orders.js";
import { createSessionChain } from "../../src/fleet/bot-session-chain.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { ROBINHOOD_TESTNET_ROUTER } from "../../src/fleet/deploy.js";
import { DEFAULT_SALT, SESSION_ACCOUNT_ABI, SESSION_FACTORY_ABI } from "../../src/fleet/session-keys.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, venuePoolKey } from "../../src/fleet/v4-swap.js";
import { connectRobinhoodFork } from "./robinhood-fork.js";

/** Verified live on 46630 (specs/001-fleet-mission/research.md, 2026-08-30). */
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FULL_RANGE = { lower: -887_220, upper: 887_220 };
const isqrt = (n: bigint): bigint => { let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const SQRT_PRICE_1000 = isqrt(1000n * 2n ** 192n);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
// The fork's first two hardhat accounts: their keys are public, their ETH is fork ETH.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const BOT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/**
 * A stop loss and a take profit on a fork of 46630, through the runner the
 * orders cron builds: the real bot chain reads the real pool, the real
 * session chain asks this tree's account and sends the bot key's `sell`.
 * Each order fires once at its level and never again: the stop when the
 * price is dumped through it, the take profit when it is pumped through
 * its own, and a run in between or after sends nothing.
 */
describe("Take profit and stop loss through the orders runner (46630 fork)", () => {
  it("each fires once at its level, sells its share into the account, and closes", async () => {
    const { viem, provider } = await connectRobinhoodFork();
    const [ownerWallet, botWallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const owner = ownerWallet!.account.address;
    const transport = custom(provider as { request: (args: { method: string; params?: unknown }) => Promise<unknown> });

    // A pool at 1000 FLEET per ETH, about 0.095 ETH deep.
    const token = await viem.deployContract("FleetVenueToken", [parseEther("1000000")]);
    const seeder = await viem.deployContract("FleetPoolSeeder", [POOL_MANAGER]);
    await token.write.approve([seeder.address, parseEther("1000000")]);
    await seeder.write.seed([venuePoolKey(token.address), SQRT_PRICE_1000, FULL_RANGE.lower, FULL_RANGE.upper, parseEther("3")], { value: parseEther("0.2") });

    // The owner's account from this tree's factory, holding 10 FLEET, the bot's key granted with let it sell on.
    const factory = await viem.deployContract("SessionAccountFactory");
    const account = await publicClient.readContract({ address: factory.address, abi: SESSION_FACTORY_ABI, functionName: "accountOf", args: [owner, DEFAULT_SALT] }) as Address;
    await ownerWallet!.writeContract({ address: factory.address, abi: SESSION_FACTORY_ABI, functionName: "createAccount", args: [owner, DEFAULT_SALT] });
    await token.write.transfer([account, parseEther("10")]);
    const block = await publicClient.getBlock();
    await ownerWallet!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "grant", args: [botWallet!.account.address, [{ target: ROBINHOOD_TESTNET_ROUTER, selector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR }], parseEther("0.01"), parseEther("0.1"), Number(block.timestamp) + 86_400] });
    await ownerWallet!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "setSellAllowed", args: [botWallet!.account.address, true] });

    // The runner as api/bot/orders.js builds it, over the fork's provider instead of an HTTP url.
    const reads = createBotChain({ chainId: 46630, rpcUrl: "fork", defaultToken: token.address, router: ROBINHOOD_TESTNET_ROUTER, poolManager: POOL_MANAGER, transport });
    const session = createSessionChain({ chainId: 46630, rpcUrl: "fork", signerKey: BOT_KEY, transport });
    assert.equal(session.signer.toLowerCase(), botWallet!.account.address.toLowerCase());
    const orders = new MemoryOrderStore();
    const links = new MemoryBotLinkStore();
    const telegram = new RecordingTelegram();
    const runner = new OrderRunner({ orders, links, reads, session, telegram });
    await links.putLink({ tgId: "7", account, owner, chainId: 46630, nonce: "n", signature: "0x00", linkedAt: new Date().toISOString() });
    const fleet = () => publicClient.readContract({ address: token.address, abi: ERC20, functionName: "balanceOf", args: [account] });

    // A stop 10% under the price now for half, a take profit 10% over it for all of it: the levels the bot's prompt stores.
    const start = (await reads.tokenInfo(token.address)).perEth;
    assert.ok(start > parseEther("990") && start < parseEther("1010"), `about 1000 FLEET per ETH: ${start}`);
    const base = { tgId: "7", account, chainId: 46630, token: token.address, ethWei: 0n, createdAt: new Date().toISOString(), status: "open" as const, refusals: 0 };
    await orders.put({ ...base, id: "sl", kind: "sl", triggerPerEth: (start * 10_000n) / 9_000n, sellPct: 50 });
    await orders.put({ ...base, id: "tp", kind: "tp", triggerPerEth: (start * 10_000n) / 11_000n, sellPct: 100 });
    const quiet = { fired: 0, landed: 0, refused: 0, waited: 0 };
    assert.deepEqual(await runner.run(), quiet, "between the levels nothing fires");
    assert.equal(await fleet(), parseEther("10"));

    // Someone dumps 20 FLEET: the price falls through the stop.
    const dump = await reads.quoteSell(token.address, parseEther("20"));
    assert.equal((await reads.sell(OWNER_KEY, token.address, parseEther("20"), minOutFor(dump!, 500))).ok, true);
    const ethBefore = await publicClient.getBalance({ address: account });
    assert.deepEqual(await runner.run(), { ...quiet, fired: 1, landed: 1 }, "the stop fires");
    assert.equal(await fleet(), parseEther("5"), "half of the position sold, and only that");
    assert.ok((await publicClient.getBalance({ address: account })) > ethBefore, "the ETH landed in the account");
    assert.equal((await orders.get("sl"))!.status, "done");
    assert.equal((await orders.get("tp"))!.status, "open");
    assert.match(telegram.last(), /^stop loss: <code>5 FLEET<\/code> \(50%\) .* landed/);
    assert.deepEqual(await runner.run(), quiet, "the stop is closed: the price still under it sells nothing more");
    assert.equal(await fleet(), parseEther("5"));

    // Someone buys 0.08 ETH: the price rises through the take profit.
    const pump = await reads.quoteBuy(token.address, parseEther("0.08"));
    assert.equal((await reads.buy(OWNER_KEY, token.address, parseEther("0.08"), minOutFor(pump!, 500))).ok, true);
    assert.deepEqual(await runner.run(), { ...quiet, fired: 1, landed: 1 }, "the take profit fires");
    assert.equal(await fleet(), 0n, "all of what was left sold");
    assert.equal((await orders.get("tp"))!.status, "done");
    assert.match(telegram.last(), /^take profit: <code>5 FLEET<\/code> \(100%\) .* landed/);
    assert.deepEqual(await runner.run(), quiet, "nothing is open, nothing fires");
    assert.equal((await orders.open(46630)).length, 0);
  });
});
