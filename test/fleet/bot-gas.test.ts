import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "viem";
import { DEFAULT_GAS_PRICE_CEILING_WEI, EXECUTE_GAS, SELL_GAS, executeGasWei, gasPriceCeilingWei, sellGasWei } from "../../src/fleet/bot-gas.js";

test("the price ceiling is 0.1 gwei by default, about three times 4663's price, not the one gwei that let a 0.002 ETH day hold three trades", () => {
  assert.equal(DEFAULT_GAS_PRICE_CEILING_WEI, 100_000_000n);
  assert.equal(gasPriceCeilingWei({}), 100_000_000n);
  assert.equal(executeGasWei(DEFAULT_GAS_PRICE_CEILING_WEI), EXECUTE_GAS * 100_000_000n);
  assert.equal(sellGasWei(DEFAULT_GAS_PRICE_CEILING_WEI), SELL_GAS * 100_000_000n);
  // The default day (0.002 ETH): 28 executes now, where one gwei allowed 2.86.
  assert.equal(parseEther("0.002") / executeGasWei(DEFAULT_GAS_PRICE_CEILING_WEI), 28n);
  assert.equal(parseEther("0.002") / (EXECUTE_GAS * 1_000_000_000n), 2n);
});

test("BOT_GAS_PRICE_GWEI sets the ceiling when it is a positive decimal; anything else is the default", () => {
  assert.equal(gasPriceCeilingWei({ BOT_GAS_PRICE_GWEI: "0.05" }), 50_000_000n);
  assert.equal(gasPriceCeilingWei({ BOT_GAS_PRICE_GWEI: " 2 " }), 2_000_000_000n);
  for (const bad of ["", "0", "-1", "abc", "1e9", "0.0000000001"]) assert.equal(gasPriceCeilingWei({ BOT_GAS_PRICE_GWEI: bad }), DEFAULT_GAS_PRICE_CEILING_WEI, bad);
});
