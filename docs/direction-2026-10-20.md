# Direction, 20 October 2026: Telegram only, then agents

Decided by the founder with the stakeholder group on 20 October 2026 (Marc, algocats, _°-°_, BenjiX, Lucian, Miprox agreed in the thread). This page is the record. ROADMAP.md tracks the work; this page says why and in what order.

## The two decisions

1. **Sunset the web app's trading pages, keep the private funding.** The FleetPool is Chit's moat: a deposit goes into a shared pool and the pool funds the trading account, so the chain never shows your wallet funding your trades. That stays, and it moves into the bot (R74 below). Today the bot's session accounts are funded straight from the user's wallet, a public link; that is the gap the pool closes. **Sunset the web app's trading pages.** Almost everyone uses the bot. The web app is a second codebase, a second deploy and a second set of bugs for pages hardly anyone opens. The landing page, the Sessions page and the competition board stay. Trading, the fleet dashboard and web deposits go. The screens that still need a screen come back as a Telegram mini app inside the bot.
2. **Chit agents.** "Trading bot" no longer explains itself. The next thing is an AI that trades for you inside your own caps, from a session account, never your keys. One sentence in plain words becomes orders the bot already has. Then an arena where agents compete with each other and with people, with $CHIT in the middle.

## Sunset, in order

| Step | Done when | Owner |
|---|---|---|
| Freeze web trading features. No new work on trade, fleet dashboard or web deposits. | PR #165 (log cap fix) is the last change to those pages | Founder |
| Tell web depositors to withdraw. One post in the group and on X: "if you ever deposited on the web app, go to app.chit.tools/app/balance and withdraw." | Posted, pinned for a week | Founder |
| The 6 October depositor's exit. Wallet `0xe2Ce…3285` requested an exit on 6 October and never executed; about 0.005 ETH waits. Only that wallet can claim it. | The ExitPaid event for that wallet, or 30 days past the post | Chain |
| Keep /app/balance until R74 ships, since it is both the only private deposit and the only Execute button. Then the bot carries deposit and exit, and the Sessions page keeps a pool exit for old depositors. | R74 live; Sessions page shows the pool exit for a wallet with a pending one | Claude |
| Redirect trade, fleet and fleet-dashboard URLs to the bot. Nothing 404s. | vercel.json rewrites; each old URL lands on t.me/… | Claude |
| Remove the web trading code and its functions (fleet/buy, fleet/trade, fleet/campaign, fleet/control). The pool, its sweep and its posting stay: the bot uses them. | `npm run test:fleet` green; chit-app deploys; bot and pool untouched | Claude |
| Cost: delete the unused Neon resources (`chit`, `legacy-keeper-db`) after confirming nothing reads them. | Vercel Storage shows only chit-mainnet and chit-fleet | Founder |

What stays on the pool contract: the FleetPool on mainnet is not upgraded, paused or drained. Depositors' funds are theirs by construction, and exits work with or without us.

## Private funding moves into the bot (R74)

| R | What | Done when | Owner | Gate |
|---|---|---|---|---|
| R74 | Fund privately, from the bot. "Fund" offers two ways: direct (today's, one tap, public link, said plainly) and private: deposit into the pool from any wallet, or from any chain through Relay straight into the pool, and after the pool's timer the operator draws the principal to your session account. The chain shows a deposit into a shared pool and, later, the pool funding an account; nothing joins the two. The pool's draw already sends to any account the operator names (`FleetPool.fund` and the principal path take an address list), so this is service and bot work, not a contract change. Caps stay the pool's: 0.1 ETH per depositor, 1 ETH pool, until the audit. | A session account funded through the pool from a fresh wallet; no transaction links the wallet to the account; the bot card says "private, not anonymous: Chit's operator can see which deposit paid for which account" | Claude builds, Lucian reviews the ownerRef sealing | Before the balance page goes. Order: with R67, before fees on |

The claim stays what it was: private, not anonymous. The operator can see which balance paid for which account and says so. Selective disclosure (view keys) is still Stage 3.

## The bot is open to everyone

Decided the same day: the $CHIT holders gate on the bot comes off. It is one variable (`CHIT_FEE_THRESHOLD=0` on chit-app) and a redeploy; PR #167 carries the copy. Holding $CHIT then means discounts and the arena, not access to the bot. The agents' cost cap (R68) switches from "holders only" to a per-user daily limit for everyone, with a higher limit for holders.

## Mini app: not yet

Asked on 20 October whether the Telegram mini app is needed now. No. Everything the bot does today works in chat with buttons. The three screens that need a page (Sessions for connect, renew and withdraw; the board; the landing page) stay as web pages, and they are the cheapest pages we have. A mini app earns its build when one of these is true: the agent confirm card needs more than a message can show, or a wallet signature has to happen inside Telegram. Neither is true for R67. Revisit at R69.

## Agents, in order

Numbering continues from the roadmap build plan (R66 was the last).

| R | What | Done when | Owner | Gate |
|---|---|---|---|---|
| R67 | One sentence becomes orders. The user writes "sell half my pepe if it drops 20%"; the bot shows what it understood (token, side, size, trigger) and asks to confirm; on yes it places the existing TP/SL, DCA, limit or shield orders. Exits only in season 1. | Ten real sentences from the group become the right orders with no wrong one placed; the confirm card always shows before any order | Claude builds, Lucian reviews | None; exits need no new permission |
| R68 | Cost guardrails. Haiku for commands, Opus only to compile an arena strategy once. Cap ~20 AI commands per user per day, ~50 for holders, alert in the operator chat if the day's spend passes $20. | A unit test refuses the 51st command; the alert fires in a dry run | Claude | None |
| R69 | Arena. A strategy in plain words runs from the writer's own account. Public board with P&L from the chain, agents and people on the same board. Competition season 2 is humans vs AI. | Board live at /app/board with an agent column; season 2 rules posted | Claude builds board, Founder sets rules | Buy-side agents wait for Orus (auto-buys). Season 1 agents are exit-only or trade a short approved list |
| R70 | Follow an agent on your own account with your own cap. Creator fee share paid in $CHIT bought from the market. | A follower's order fires from the follower's account inside the follower's cap | Claude | Fees on (R41 to R44) and a legal check on the fee share |
| R71 | Lock $CHIT to list an agent. Access to the board, never a yield. | A listing without the lock is refused; the lock is described as access in every surface | Claude | Fees on. Copy reviewed against the claims table |
| R72 | Outside agents, Orus first: its own session key on the user's account, with a cap and an expiry. | Orus places one order on a test account that it cannot exceed or outlive | Lucian, with Orus | Orus's side |
| R65 | Tokenized equities from Telegram. | Unchanged: one page in docs/ with the liquidity and issuer-terms answer | Founder | Legal. Runs in parallel, decides nothing yet |

Order, revised 20 October after the founder's call that the direction runs on fees: fees on is step two, not step five. R67 (one to two weeks) with R68 and R74 (private funding in the bot, the moat); **fees on (R41 to R44, R50) right after**, since the agents' creator share, the lock and the burn line all wait on it and the $4k only bridges until then; R69 once fees are on; R70 to R72 after. R65 is a check, not a build. Fees on still needs the founder's numbers (R04): the rate, the holder discount, the burn share.

## Cost plan, as agreed

The AI translates once. After that the orders run in the cron with no model in the loop. Estimates at current prices, 500 active users at 10 commands a day: Haiku about $75 a month, Sonnet about $1.3k, Opus about $2.5k. Decision: Haiku for commands, Opus for strategy compiles, measured after the first few hundred commands. The $4k in fees covers it until trading fees switch on. BenjiX's point stands: APIs cost money, so the spend alert is not optional.

### 0G compute, checked 20 October

What 0G offers, from its docs and its own build page: an OpenAI-compatible endpoint (change the base URL, keep the SDK), open models only (Qwen 2.5 and 3.x, DeepSeek V3.1, GPT-OSS 120B, GLM-5, their own 0GM-1.0-35B), paid in 0G tokens from a prepaid ledger (3 OG minimum), fees settled on chain in batches. Three trust modes per request: Standard (no attestation), Verified (signed proof of which model ran) and Private (the prompt inside an Intel TDX plus H100/H200 enclave, so neither 0G nor the provider sees it). Their page says most models are not in a TEE. Per-user defaults of 30 requests a minute and 5 concurrent. Their price claim is about $0.003 per 1K tokens against GPT-4's $0.03; per-model prices live only in their catalog, not in the docs.

Read against our use:

- **Fit:** the job is extraction (one sentence to a typed order). An open 30B to 120B model can do that. No Haiku on 0G. (Corrected 22 October: this first read covered only the Compute Network. 0G Private Computer lists ten Claude models, Sonnet 4.5 to Opus 5.5 and Fable 5.1, none with Haiku, none with the TEE badge, the cheapest Sonnet 5 at $1.90 in and $9.50 out per million tokens. So 0G gives either Claude without the enclave or an open model inside it.)
- **Cost:** in the same band as Haiku on paper, unknown in practice, and paid in a volatile token we would have to hold and top up.
- **Privacy:** real only in Private mode on the few TEE providers. And the order the user writes ends up in our database the moment it becomes a TP/SL, so the TEE protects the prompt in flight, not the fact of the trade. The honest claim would be "the model never sees your prompt in the clear", not "private trading".
- **Ops:** a wallet, a ledger, provider health, 429s at 30 a minute, batch settlement. All new surface for a two-person team.

Decision: Haiku now. Build R67 behind one small `translate(sentence) -> orders` interface with an OpenAI-shaped client, so 0G is a config change later. Run a side-by-side on the first two hundred real sentences (Haiku vs one 0G model in Private mode) and switch only if 0G matches Haiku's accuracy and the privacy line survives the claims table. Sources: docs.0g.ai compute inference and SDK pages, build.0g.ai/compute, 0G's April 2026 Private Computer announcement.

## Claims to hold the line on

- An agent trades inside caps the user set, from a session account. Say that. Do not say "AI makes you money" or quote returns.
- The lock is access to the arena. Never "stake", never "yield", never "APY".
- Stocks in Telegram is a check, not a promise. No ticker in public copy until R65 clears.
- Private, not anonymous. The agent sees your orders because you asked it to; it never sees your keys.
- Every "burns $CHIT" line follows the fee facts once fees are on, not before.

## Today's posts (20 October)

The group asked for daily presence and a push on X. Two posts today, both in the founder's voice. Then the catalyst tease for agents goes out when R67 has a date, not before.

**TG, big text, then X:**

> quick update on where chit is going.
>
> we're sunsetting the web app's trading pages. nearly everyone trades from the bot, and the site was a second codebase eating time that should go into the bot. the landing page, sessions and the leaderboard stay. anything that still needs a screen comes back as a mini app inside telegram.
>
> if you ever deposited on the web app, go to app.chit.tools/app/balance and withdraw. nothing is going anywhere, the contract pays exits on its own, but the easy button lives on that page.
>
> what comes next is bigger and I'll say it when the first piece works, not before.

**X reply bank for Miprox, big accounts:** keep it to what is live. "session accounts: the bot trades inside your caps, never your keys, off with one tap." "take profit and stop loss live since the 10th." "rug shield: if the alarm fires on a token you hold, the bot sells before anyone is told." One line, one link, no thread.

## Log

| Date | Change |
|---|---|
| 2026-10-20 | Decided with stakeholders. This page written. ROADMAP.md "Right now" updated |
| 2026-10-20 | Founder: the direction runs on fees (fees on moves to step two), the bot opens to everyone (PR #167), no mini app yet, 0G compute checked and parked behind Haiku |
| 2026-10-20 | Founder: private funding stays, it is the moat. R74 moves the pool deposit into the bot; the balance page stays until then; the pool and its sweep are not removed |
| 2026-10-22 | Founder: stay on Haiku direct. The "no Claude on 0G" line corrected above. R67 built on PR #168; the translator speaks Anthropic's Messages format, which 0G's Claude entries also use, so a later switch is likely a base URL and a key (not yet checked against 0G's API docs) |
