import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from "viem";

import { createBotChain } from "../../src/fleet/bot-chain.js";
import { DEFAULT_SALT, PERMIT2, SESSION_ACCOUNT_ABI, SESSION_FACTORY_ABI, encodeSell } from "../../src/fleet/session-keys.js";
import { UNIVERSAL_ROUTER_EXECUTE_SELECTOR, minOutFor, venuePoolKey } from "../../src/fleet/v4-swap.js";
import { connectRobinhoodMainnetFork } from "./robinhood-fork.js";

/**
 * The CHOP report (2026-10-07) replayed on a fork of 4663. CHOP fixes
 * Permit2's allowance at infinity for every holder and refuses any other
 * approve to it, so the account from the deployed factory (0xb2b2…aecda),
 * whose sell set an exact approval and cleared it, reverted every time. The
 * account built from this tree skips that approval for such a token and
 * sells: the real CHOP, through the real router and pool, into the account.
 *
 * The CHOP comes from the reporter's own account, moved by impersonating its
 * owner with the owner's withdrawToken; nothing on the live chain changes.
 */

const MAINNET_RPC = process.env.ROBINHOOD_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const CHOP: Address = "0x100765a16f42636Bd84EE1e86Bc5107b84bCdBA3";
const REPORTER_ACCOUNT: Address = "0x42db6078001da1f52706699de65c8beb139041c7";
const DEPLOYED_FACTORY: Address = "0xb2b2913c07344e60c2ca25caf5580972f3aaecda";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)"]);
const PERMIT2_ALLOWANCE = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);
const WITHDRAW_TOKEN = parseAbi(["function withdrawToken(address token, address to, uint256 amount)"]);

describe("A token with Permit2 fixed at infinity sells through the session (4663 fork)", () => {
  it("the deployed factory's account reverts on CHOP; this tree's account sells it into the account", async () => {
    const { viem, provider } = await connectRobinhoodMainnetFork();
    const [ownerWallet, botWallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    await provider.request({ method: "evm_mine", params: [] });
    const bot = botWallet!.account;
    const chop = (a: Address) => publicClient.readContract({ address: CHOP, abi: ERC20, functionName: "balanceOf", args: [a] });

    // The pool and a quote, read the way the bot reads them.
    const reads = createBotChain({ chainId: 4663, rpcUrl: MAINNET_RPC, defaultToken: CHOP, router: ROUTER, poolManager: POOL_MANAGER });
    const info = await reads.tokenInfo(CHOP);
    assert.ok(info.hasPool, "CHOP has an ETH pool on the venue");
    const poolKey = info.poolKey ?? venuePoolKey(CHOP);
    assert.equal(await publicClient.readContract({ address: CHOP, abi: ERC20, functionName: "allowance", args: [REPORTER_ACCOUNT, PERMIT2] }), 2n ** 256n - 1n, "CHOP fixes Permit2's allowance at infinity");

    // Two accounts for the same owner: one from the deployed factory, one from this tree's.
    const fresh = await viem.deployContract("SessionAccountFactory");
    const accountOf = async (factory: Address, salt: Hex) => {
      const a = await publicClient.readContract({ address: factory, abi: SESSION_FACTORY_ABI, functionName: "accountOf", args: [ownerWallet!.account.address, salt] });
      await publicClient.waitForTransactionReceipt({ hash: await ownerWallet!.writeContract({ address: factory, abi: SESSION_FACTORY_ABI, functionName: "createAccount", args: [ownerWallet!.account.address, salt] }) });
      return a as Address;
    };
    const oldAccount = await accountOf(DEPLOYED_FACTORY, DEFAULT_SALT);
    const newAccount = await accountOf(fresh.address, DEFAULT_SALT);

    // Real CHOP into both: the reporter's owner takes it out of their account, as the Sessions page would.
    const reporterOwner = await publicClient.readContract({ address: REPORTER_ACCOUNT, abi: SESSION_ACCOUNT_ABI, functionName: "owner" }) as Address;
    await provider.request({ method: "hardhat_impersonateAccount", params: [reporterOwner] });
    await provider.request({ method: "hardhat_setBalance", params: [reporterOwner, "0x16345785D8A0000"] });
    const held = await chop(REPORTER_ACCOUNT);
    assert.ok(held > 0n, "the reporter's account still holds CHOP");
    const half = held / 2n;
    for (const to of [oldAccount, newAccount]) {
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: reporterOwner, to: REPORTER_ACCOUNT, data: encodeFunctionData({ abi: WITHDRAW_TOKEN, functionName: "withdrawToken", args: [CHOP, to, half] }) }] }) as Hex;
      assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, "success");
    }

    // The bot gets a session on each, with the router's execute and the sell flag.
    const block = await publicClient.getBlock();
    for (const account of [oldAccount, newAccount]) {
      await ownerWallet!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "grant", args: [bot.address, [{ target: ROUTER, selector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR }], parseEther("0.05"), parseEther("0.5"), Number(block.timestamp) + 86_400] });
      await ownerWallet!.writeContract({ address: account, abi: SESSION_ACCOUNT_ABI, functionName: "setSellAllowed", args: [bot.address, true] });
    }

    const amountIn = half / 2n;
    const quote = await reads.quoteSell(CHOP, amountIn);
    assert.ok(quote !== null && quote > 0n, "a quote for the sale");
    const minOut = minOutFor(quote!, 1000);
    const sell = (account: Address) => botWallet!.sendTransaction({ to: account, data: encodeSell({ router: ROUTER, token: CHOP, amountIn, minOut, deadline: block.timestamp + 3600n, poolKey }), gas: 1_500_000n });

    // The deployed account: the sale the reporter saw, reverted.
    let oldReverted = false;
    try {
      const r = await publicClient.waitForTransactionReceipt({ hash: await sell(oldAccount) });
      oldReverted = r.status !== "success";
    } catch { oldReverted = true; }
    assert.ok(oldReverted, "the deployed factory's account cannot sell CHOP");
    assert.equal(await chop(oldAccount), half, "and nothing moved");

    // This tree's account: the same sale lands, the ETH into the account, nothing approved to the router after.
    const ethBefore = await publicClient.getBalance({ address: newAccount });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await sell(newAccount) });
    assert.equal(receipt.status, "success", "this tree's account sells CHOP");
    assert.equal(await chop(newAccount), half - amountIn, "the amount sold left, and only that");
    const gained = (await publicClient.getBalance({ address: newAccount })) - ethBefore;
    assert.ok(gained >= minOut, `the ETH landed in the account: ${gained} wei for a floor of ${minOut}`);
    const [left] = await publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ALLOWANCE, functionName: "allowance", args: [newAccount, CHOP, ROUTER] });
    assert.equal(left, 0n, "Permit2's allowance to the router is cleared after the sale");
    console.log(`sold ${amountIn} CHOP for ${gained} wei (floor ${minOut}) on the fork; the deployed account reverted on the same sale`);
  });
});
