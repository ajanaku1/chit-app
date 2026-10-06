import assert from "node:assert/strict";
import { test } from "node:test";

import { createLaunchCheck } from "../../src/fleet/bot-launchpad.js";
import type { Address } from "../../src/fleet/types.js";

const TOKEN = "0x00000000000000000000000000000000000000c1" as Address;
const CURVE = "0x00000000000000000000000000000000000000cc" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

test("the launchpad check: a launch whose curve has not graduated is on its curve, with its threshold; graduated, or not a launch, or a failed read, is not", async () => {
  const read = (launch: { curve: string; graduationThreshold: bigint }, graduated: boolean | Error) => async ({ functionName }: { functionName: string }) => {
    if (functionName === "getLaunchedToken") return { token: TOKEN, curve: launch.curve, graduationThreshold: launch.graduationThreshold };
    if (graduated instanceof Error) throw graduated;
    return graduated;
  };
  assert.deepEqual(await createLaunchCheck({ factory: CURVE, readContract: read({ curve: CURVE, graduationThreshold: 42n }, false) as never })(TOKEN), { onCurve: true, thresholdWei: 42n });
  assert.deepEqual(await createLaunchCheck({ factory: CURVE, readContract: read({ curve: CURVE, graduationThreshold: 42n }, true) as never })(TOKEN), { onCurve: false });
  assert.equal(await createLaunchCheck({ factory: CURVE, readContract: read({ curve: ZERO, graduationThreshold: 0n }, false) as never })(TOKEN), undefined, "not a launch");
  assert.equal(await createLaunchCheck({ factory: CURVE, readContract: read({ curve: CURVE, graduationThreshold: 42n }, new Error("rpc")) as never })(TOKEN), undefined, "unread is not a claim");
});
