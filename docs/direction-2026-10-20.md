# Direction, 20 October 2026: Telegram only, then agents

Decided by the founder with the stakeholder group on 20 October 2026 (Marc, algocats, _°-°_, BenjiX, Lucian, Miprox agreed in the thread). This page is the record. ROADMAP.md tracks the work; this page says why and in what order.

## The two decisions

1. **Sunset the web app's trading pages.** Almost everyone uses the bot. The web app is a second codebase, a second deploy and a second set of bugs for pages hardly anyone opens. The landing page, the Sessions page and the competition board stay. Trading, the fleet dashboard and web deposits go. The screens that still need a screen come back as a Telegram mini app inside the bot.
2. **Chit agents.** "Trading bot" no longer explains itself. The next thing is an AI that trades for you inside your own caps, from a session account, never your keys. One sentence in plain words becomes orders the bot already has. Then an arena where agents compete with each other and with people, with $CHIT in the middle.

## Sunset, in order

| Step | Done when | Owner |
|---|---|---|
| Freeze web trading features. No new work on trade, fleet dashboard or web deposits. | PR #165 (log cap fix) is the last change to those pages | Founder |
| Tell web depositors to withdraw. One post in the group and on X: "if you ever deposited on the web app, go to app.chit.tools/app/balance and withdraw." | Posted, pinned for a week | Founder |
| The 6 October depositor's exit. Wallet `0xe2Ce…3285` requested an exit on 6 October and never executed; about 0.005 ETH waits. Only that wallet can claim it. | The ExitPaid event for that wallet, or 30 days past the post | Chain |
| Keep /app/balance until then, since it is the only Execute button. Fold the exit into the Sessions page before the balance page goes. | Sessions page shows the pool exit for a wallet with a pending one | Claude |
| Redirect trade, fleet and fleet-dashboard URLs to the bot. Nothing 404s. | vercel.json rewrites; each old URL lands on t.me/… | Claude |
| Remove the web trading code and its functions (fleet/buy, fleet/trade, fleet/campaign, fleet/control, sweeps that only the web pool used). | `npm run test:fleet` green; chit-app deploys; bot untouched | Claude |
| Cost: delete the unused Neon resources (`chit`, `legacy-keeper-db`) after confirming nothing reads them. | Vercel Storage shows only chit-mainnet and chit-fleet | Founder |

What stays on the pool contract: the FleetPool on mainnet keeps working for exits with or without us. It is not upgraded, paused or drained. Depositors' funds are theirs by construction.

## Agents, in order

Numbering continues from the roadmap build plan (R66 was the last).

| R | What | Done when | Owner | Gate |
|---|---|---|---|---|
| R67 | One sentence becomes orders. The user writes "sell half my pepe if it drops 20%"; the bot shows what it understood (token, side, size, trigger) and asks to confirm; on yes it places the existing TP/SL, DCA, limit or shield orders. Exits only in season 1. | Ten real sentences from the group become the right orders with no wrong one placed; the confirm card always shows before any order | Claude builds, Lucian reviews | None; exits need no new permission |
| R68 | Cost guardrails. Haiku for commands, Opus only to compile an arena strategy once. Cap ~50 AI commands per user per day, holders only (the gate exists), alert in the operator chat if the day's spend passes $20. | A unit test refuses the 51st command; the alert fires in a dry run | Claude | None |
| R69 | Arena. A strategy in plain words runs from the writer's own account. Public board with P&L from the chain, agents and people on the same board. Competition season 2 is humans vs AI. | Board live at /app/board with an agent column; season 2 rules posted | Claude builds board, Founder sets rules | Buy-side agents wait for Orus (auto-buys). Season 1 agents are exit-only or trade a short approved list |
| R70 | Follow an agent on your own account with your own cap. Creator fee share paid in $CHIT bought from the market. | A follower's order fires from the follower's account inside the follower's cap | Claude | Fees on (R41 to R44) and a legal check on the fee share |
| R71 | Lock $CHIT to list an agent. Access to the board, never a yield. | A listing without the lock is refused; the lock is described as access in every surface | Claude | Fees on. Copy reviewed against the claims table |
| R72 | Outside agents, Orus first: its own session key on the user's account, with a cap and an expiry. | Orus places one order on a test account that it cannot exceed or outlive | Lucian, with Orus | Orus's side |
| R65 | Tokenized equities from Telegram. | Unchanged: one page in docs/ with the liquidity and issuer-terms answer | Founder | Legal. Runs in parallel, decides nothing yet |

Order: R67 (one to two weeks), R68 with it, R69 (one more week), then R70 to R72 after fees switch on. R65 is a check, not a build.

## Cost plan, as agreed

The AI translates once. After that the orders run in the cron with no model in the loop. Estimates at current prices, 500 active users at 10 commands a day: Haiku about $75 a month, Sonnet about $1.3k, Opus about $2.5k. Decision: Haiku for commands, Opus for strategy compiles, measured after the first few hundred commands. The $4k in fees covers it until trading fees switch on. BenjiX's point stands: APIs cost money, so the spend alert is not optional.

The 0G decentralized compute idea (conversations in a TEE) is noted, not decided. It needs a cost and latency check against Haiku before anything is built on it.

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
