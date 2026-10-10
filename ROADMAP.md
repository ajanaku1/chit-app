# Chit roadmap

One file for what is live, what is coming, in what order, and where each piece stands. Public copy is drawn from here; the build detail with owners and done predicates is in [docs/roadmap-build-2026-10-08.md](docs/roadmap-build-2026-10-08.md), keyed by the same R numbers.

Nothing below carries a public date until it is merged. Weeks are planning weeks, not promises.

## Where we are

**Week 1 of 5** (13 to 19 October 2026). The weekly drop is one-tap links.

**Right now:** PR #146 (links) and #147 (app front door) are green and waiting for a merge. Take profit and stop loss, session-expiry messages and the alerts stack are merged and waiting for one deploy of chit-app, which needs `BOT_LAUNCHPAD_FACTORY` set on the watch function first.

**Next up:** merge and deploy, post the links drop, then take profit and stop loss goes out in week 2.

## How to read the status

| Status | Means |
|---|---|
| planned | In the plan, nobody has started |
| building | Someone is on it, no PR yet |
| PR | A pull request is open |
| merged | On main, not in production |
| deployed | Live on the host it belongs to |
| announced | Posted on X and in the group; the drop is done |
| held | Waiting on something named in the row |

A drop is done at **announced**, nothing earlier.

## Live now

| What | Since | Notes |
|---|---|---|
| Mainnet beta: the private funding pool, capped | late September 2026 | 1 ETH pool, 0.1 per depositor, 0.05 per draw. Not audited by a firm. Operator key can move what is in the pool up to the cap. Guardian can pause |
| The bot with session keys, positions, limit orders, DCA, curve warning | 1 October 2026 | Your key stays with you. Chit pays the gas during the beta |
| The 48 hour soak | before the beta opened | Confirmed done 8 October |
| ChitBuyback: ownerless hourly buy and burn | 16 September 2026 | 17.38M $CHIT over 391 buys as of 8 October. Burns what it is sent |
| The 100,000 $CHIT line, plus invited wallets | beta open | A throttle, comes off in steps after the audit |
| Trading competition, $1,000 USDG | 2 October 2026 | Extended to 31 October 12:00 UTC. Board at app.chit.tools/app/board |
| CHOP class sell fix (Permit2-fixed tokens) | 8 October 2026 | PRs 137, 139, 140, 142. Live on chit-app |
| Burn page shows no stale figure | 8 October 2026 | PR 145. Live on chit.tools |
| Testnet playground, ungated | 6 September 2026 | testnet.chit.tools |

## The five drops

| Week | Dates | Drop | R | Owner | Status | What moves it |
|---|---|---|---|---|---|---|
| 1 | 13 to 19 Oct | One-tap links: `t-<token>` opens the card for anyone; `t-<token>-<code>` credits the group | R10 | Claude | PR #146 | merge, deploy chit-app, post |
| 1 | 13 to 19 Oct | App front door goes to /app/balance | R13 | Claude | PR #147 | merge, deploy chit-app |
| 1 | 13 to 19 Oct | Bot event log in Neon, referral attribution store | R11, R14 | Claude | planned | start after #146 lands |
| 2 | 20 to 26 Oct | Take profit and stop loss | R17, R20 | Lucian | merged | deploy chit-app, post |
| 2 | 20 to 26 Oct | Session-expiry messages, Renew as a fresh Connect | R23 | Lucian | merged | same deploy |
| 3 | 27 Oct to 2 Nov | Alerts: graduation, rug alarm, holders first | R25, R30 | Lucian | merged | `BOT_LAUNCHPAD_FACTORY` on the watch function, the port's fork test, deploy, post |
| 3 | 31 Oct 12:00 UTC | Competition closes: score, pay, publish, interview the winner | R31 | Founder, CM | planned | the date |
| 4 | 3 to 9 Nov | Community boards, the next competition's format | R33, R40 | Claude | planned | the scoring rule (distinct wallets and counted trades, never raw volume) |
| 5 | 10 to 16 Nov | Fees on: rate, holder discount, first trade on us, fixed share to the burn, P&L burn counter, referral payouts | R41 to R44, R50 | Claude builds, Founder decides | held | the founder's fee numbers (R04) |

## After the five, no dates

| What | R | Owner | Status | What moves it |
|---|---|---|---|---|
| Private bot trades: Telegram trades funded through the pool. Private, not anonymous | R60, R61 | Lucian spec, then build | planned | the spec, after fees and alerts |
| Auto-buy within your limits on graduation | R62 | Lucian | held | Orus back on the card |
| Copy trading | R63 | Lucian | held, built | Orus |
| The audit; then caps and the line come off in steps | R64 | Founder, Boye | planned | firm and budget |
| Positioning page, comparison page, bubble-map page | R21, R34 | Claude, Founder | planned | hours |
| CoinGecko and CoinMarketCap listings | campaign | Founder | planned | the forms |
| extend(key, expiry) on the next SessionAccount factory, so Renew is one tap | Lucian raised 9 Oct | Founder decision | open | a yes or a no |
| Tokenized equities from Telegram | R65 | Founder | held | the liquidity and issuer-terms check |
| "Why did it pump?" on the card, holders only | R66 | Claude | planned | a kill criterion first |
| Stage 3: the ZK pool, even the operator cannot see the link | Goal.md | later | planned | privacy tech not yet on Robinhood Chain |

## Never

Multi-wallet buys at launch to make a token look wanted. Any auto-buy before Orus returns. A public dollar figure for the burn or the line. A price or market cap target anywhere, including creator DMs. A date for anything above before it is merged.

## How we keep this current

- The PR that changes a row's status edits this file in the same PR. A merge without the row moving is a merge that did not happen, as far as this file knows.
- Monday, before the ledger post, the founder and the CM read "Where we are" and rewrite it in two minutes. The ledger's "what is next" line is copied from here.
- When a drop is announced, its row moves to "Live now" with the date, and the week's row is deleted.
- Open founder decisions stay in the "After" table with status `open` until they are decided, then the row says what was decided.

## Log

| Date | Change |
|---|---|
| 2026-10-08 | Roadmap update written (X Article draft), build plan created with R numbers, competition extended to 31 October |
| 2026-10-08 | PRs 140, 144, 145 merged and deployed. #146 and #147 opened |
| 2026-10-09 | Lucian's #148 (TP/SL), #149 (expiry), #150 (alerts) merged. #138 reopened, needs rebase. #146 rebased after conflict |
| 2026-10-10 | This file created. Daily cadence and catalyst posts written (marketing/CHIT-CATALYST-POSTS-2026-10-10.md) |
