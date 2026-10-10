# Roadmap build plan, from 8 October 2026

Everything the October roadmap and the marketing plan commit to, as one list with an owner, a week and a done predicate. Owners: Founder (F), Lucian (L), Claude in this repo (C), CM, Boye (B). Weeks start Monday 13 Oct; week 0 is 8 to 12 Oct. "Done" means the predicate passes, nothing else. A task that needs a decision lists it; nothing is built on a guess.

Source documents: marketing/CHIT-ROADMAP-UPDATE-2026-10-08.md (the X article), marketing/FOR-LUCIAN-SHIPPING-PLAN-2026-10-08.md, marketing/CHIT-MARKETING-PLAN-2026-10-07.md §9, marketing/CHIT-TOKEN-CAMPAIGN-2026-10-07.md.

## Week 0 (8 to 12 Oct): ship the roadmap, unblock

| ID | Item | Owner | Done when |
|---|---|---|---|
| R01 | Four campaign images from the short version's brief (burn card 16:9 and square, gas card, P&L mock, board screenshot) | CM, editor | Files in brand/ and posted in the group for sign-off |
| R02 | Teaser post, X Article, Telegram pin, founder quote-post, in that order | CM, F | Article URL live on @usechit and pinned in the group |
| R03 | DexScreener description and socials, Telegram group description, pinned welcome, BRAND-TRUTH purpose line rewritten; staleness banner on the 31 Aug community brief | CM, F | Each surface shows the roadmap-update text; `grep -c "gas desk" brand/BRAND-TRUTH.md` is 0 |
| R04 | Fee rate, holder discount and buyback share decided | F | One line each in loop/memory/STATE.md under "decisions" |
| R05 | Partner sheet created with the nine tokens from the campaign; CHOP DM sent | CM, F | Sheet exists; CHOP row has a sent date |
| R06 | Buyback contract top-up rule for the beta (how much, how often, until fees) | F | One line in STATE.md; "Waiting to burn" is above 0.002 ETH at each Monday ledger |

## Week 1 (13 to 19 Oct): links and plumbing

| ID | Item | Owner | Done when |
|---|---|---|---|
| R10 | One-tap links: `start=buy_<address>` opens the token card; `buy_<address>_<code>` also records the referral; malformed falls back to home | C | PR merged; tests: known token opens its card with no buy sent, code recorded once, redelivery not twice, malformed shows home, mixed-case address resolves |
| R11 | Bot event log in Neon: /start, gate pass or fail, account created, session granted, first buy, second buy, first sell, revoke | C | PR merged; `npm run funnel` prints counts per event for the last 7 days |
| R12 | Site analytics on chit.tools and app.chit.tools | F decides, C builds | Dependency proposal in STATE.md; if approved, page views visible in the Vercel dashboard |
| R13 | app.chit.tools root goes to /app/balance, not chit.tools; no .html links left in bot messages | C | `curl -sI https://app.chit.tools \| grep -i location` shows /app/balance; `grep -rn "\.html" src/fleet/bot-*.ts` is empty |
| R14 | Referral attribution logged for `r-<code>` and `buy_..._<code>`; "referrals during the beta count from day one of fees" published | C, CM | Attribution table has rows; the line is in the pin and on X |
| R15 | Weekly ledger post, manual the first two Mondays | CM | Posted 13 and 20 Oct, counts only |
| R16 | Burn weekly summary rendered by announce-pool for X | C | Workflow posts one line each Monday with burns and buys for the week |
| R17 | Take profit and stop loss, built | L | PR open with the five tests from the shipping plan |

## Week 2 (20 to 26 Oct): take profit and stop loss

| ID | Item | Owner | Done when |
|---|---|---|---|
| R20 | TP/SL merged and deployed; drop post with its one sentence and a clip | L builds, F deploys, CM posts | Order fires once at the level in a fork test; chit-app production deployed; post live |
| R21 | Positioning page for the CM: one sentence, pitch order, say and never-say, case rule | C drafts, F approves | marketing/CHIT-POSITIONING.md exists and the CM confirms it replaces the five briefs |
| R22 | Partner cards sent to the first five tokens with their codes | CM | Five rows in the sheet with sent dates; at least one posted |
| R23 | Session-expiry message (three days before, and on expiry with one-tap renew) | L | PR merged; test: a session expiring in 72 h gets one message, expired gets one with the renew button |
| R24 | First funnel read: /start to first buy by week, from R11 | C | A table in STATE.md, no interpretation yet |
| R25 | Graduation alerts, rug alarm (liquidity pulled, dev selling), holders-first feed, built on the watcher | L | PR open; tests: curve exit alerts once, liquidity drop alerts once with an exit button, holders get the message before the group |

## Week 3 (27 Oct to 2 Nov): alerts, and the competition closes

| ID | Item | Owner | Done when |
|---|---|---|---|
| R30 | Alerts merged and deployed; drop post | L, F, CM | Deployed; post live |
| R31 | Competition closes 31 Oct 12:00 UTC: score, exclude team ids, DM winners, pay, publish board, winner interview | F, CM | `npm run comp-score` output posted; payouts sent; interview thread live |
| R32 | Second competition announced for four weeks after, community-board format | F, CM | Dates and theme in STATE.md and posted |
| R33 | Community boards: board grouped by community, scored on distinct wallets and counted trades above the minimum, capped per wallet | C | PR merged; test: two wallets trading 50 times score the same as two wallets trading 5 times |
| R34 | Comparison page "Chit against the bots you know" and "What a bubble map sees" | C drafts, F approves | Pages live at /compare and /bubble-map, humanized |
| R35 | Ten more partner groups reached | CM | Fifteen rows with sent dates |

## Week 4 (3 to 9 Nov): community boards, fees prepared

| ID | Item | Owner | Done when |
|---|---|---|---|
| R40 | Community boards deployed; drop post | C, F, CM | Deployed; post live |
| R41 | Fee switch wired to R04's numbers: fee on bot swaps, holder discount, fleet draw fee, first trade exempt per account, fixed share to the buyback | C | PR open; fork tests: fee taken at the rate, discount at the line, first trade on an account pays nothing, buyback share arrives |
| R42 | Rate page and /help copy, humanized | CM drafts, F approves | marketing/CHIT-FEES.md approved |
| R43 | Personal burn counter on the P&L card ("your trades burned N $CHIT") | C | PR open; test: the card shows the account's share of burns since fees, in $CHIT, never dollars |
| R44 | Referral payouts from fees, counts never amounts in public | C | PR open; test: a referred account's fee pays the referrer's share |
| R45 | Ecosystem asks sent: Pons, Robinhood Chain, Relay, HEY, Orus | F, L | Five sent dates in the sheet |

## Week 5 (10 to 16 Nov): fees on

| ID | Item | Owner | Done when |
|---|---|---|---|
| R50 | Fees, burn counter and referral payouts merged and deployed; fee launch week per the marketing plan §8 | C builds, F deploys, CM posts | Deployed; first fee-funded burn posted; first payout count posted |
| R51 | First retention read: second-week return rate for competition entrants | C | Table in STATE.md |
| R52 | Two creators seeded on referral share with the creator brief | CM, F | Two agreements, disclosed |

## Q2 (after week 5)

| ID | Item | Owner | Done when |
|---|---|---|---|
| R60 | Private bot trades spec: what the bot can do on a fleet account, what the operator can see, what the user is told at setup | L drafts, F and C review | specs/004-private-bot-trades/spec.md approved |
| R61 | Private bot trades build | L, C | Its own done predicate in the spec |
| R62 | Graduation auto-buy within limits | L | Waits for Orus; not before |
| R63 | Copy trading launch | L | Waits for Orus |
| R64 | Audit engaged | F, B | Firm named in STATE.md; report published when done |
| R65 | Tokenized equities check: open pools with liquidity, issuer terms on who may hold | F | One page in docs/; decision recorded |
| R66 | "Why did it pump?" experiment, holders only, rate limited | C | Spec first; kill criterion written before the first line |

## Not built, on purpose

Multi-wallet buys to look organic. Any auto-buy before Orus returns. Any public dollar figure for the burn. Any date for anything above before it is merged.

## Dependencies that gate the weeks

- R04 (fee numbers) gates R41 to R44 and therefore week 5.
- R12 is a dependency proposal, not a build, until the founder says yes.
- R25 and R30 ship on the watcher branch work that was held until the soak; the soak is done.
- Orus gates R62 and R63 and nothing else.

## Status log

| Date | ID | State |
|---|---|---|
| 2026-10-08 | R10 | PR #146 open, one-tap links for anyone plus a referral code on the link; 55 bot-session tests pass |
| 2026-10-08 | R13 | PR #147 open, app.chit.tools root to /app/balance; the .html half was already done by #126 |
| 2026-10-09 | R17, R20 | PR #148 merged: take profit and stop loss with a 46630 fork test where each fires once at its level. Deploy of chit-app pending |
| 2026-10-09 | R23 | PR #149 merged: session-expiry messages, Renew is a fresh Connect (the account cannot extend a session; extend(key, expiry) on the next factory is the founder's call) |
| 2026-10-09 | R25 | PR #150 merged: graduation alerts, rug alarm, holders-first on the watcher. R30 waits on the port's fork test and on BOT_LAUNCHPAD_FACTORY being set on the watch function |
| 2026-10-09 | 138 | Lucian's gas-ceiling PR reopened for verify; conflicts with #148, rebase asked |
| 2026-10-10 | R10, R13, R17, R20, R23, R25 | #146 and #147 merged; chit-app deployed from 00a9edb with all of them. Links and the front door are live; take profit and stop loss, expiry messages and alerts are live ahead of their weeks and wait for their posts. R30's fork test still open |
