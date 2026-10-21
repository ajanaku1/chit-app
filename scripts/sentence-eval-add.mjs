#!/usr/bin/env node
// Adds one labelled sentence to the SC-001 evaluation set
// (specs/006-agent-sentences, research R8 and R13) without ever writing the
// sentence itself: the file holds HMAC-SHA256(BOT_KEY_SECRET, normalized
// sentence) as hex, the held-token context, and the orders the founder says
// the sentence should become.
//
//   BOT_KEY_SECRET=… node scripts/sentence-eval-add.mjs "<sentence>" '<context json>' '<expect json>'
//
//   context: { "held": [{ "symbol": "CHIT", "tail": "e91d" }], "perEth": { "e91d": "1234.5" } }
//   expect:  [{ "kind": "limit", "token": "CHIT", "size": "0.05", "level": "0.9" }]
//
// Normalization is the bot's own: lowercase, whitespace collapsed to one
// space, trimmed. The same sentence always yields the same hash, so a
// duplicate is refused rather than stored twice. Refuses to run without the
// secret: a hash under a made-up key would never match production's.

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../test/fleet/eval/sentences.json", import.meta.url);

/** The bot's sentence normalization (research R8): one shape for the same words. */
export const normalizeSentence = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** HMAC-SHA256 hex of the normalized sentence under the sealing secret. */
export const sentenceHash = (secret, text) => createHmac("sha256", secret).update(normalizeSentence(text)).digest("hex");

const fail = (message) => { console.error(message); process.exit(1); };

const main = () => {
  const secret = process.env.BOT_KEY_SECRET;
  if (!secret) fail("BOT_KEY_SECRET is required: the hash must match production's");
  const [sentence, contextArg, expectArg] = process.argv.slice(2);
  if (!sentence || !contextArg || !expectArg) fail("usage: sentence-eval-add.mjs <sentence> <context json> <expect json>");
  let context, expect;
  try { context = JSON.parse(contextArg); expect = JSON.parse(expectArg); }
  catch (error) { fail(`context and expect must be JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(context.held) || typeof context.perEth !== "object") fail("context needs { held: [...], perEth: {...} }");
  if (!Array.isArray(expect)) fail("expect must be an array of orders (empty for a refusal)");
  const hash = sentenceHash(secret, sentence);
  const entries = JSON.parse(readFileSync(file, "utf8"));
  if (entries.some((entry) => entry.hash === hash)) fail(`already recorded: ${hash.slice(0, 12)}… (${entries.length} entries)`);
  entries.push({ hash, context, expect });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`${hash.slice(0, 12)}… recorded (${entries.length} of 30)`);
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
