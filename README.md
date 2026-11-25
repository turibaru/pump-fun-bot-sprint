# Pump.fun Bot Sprint — Launch Sniper

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/turibaru/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/turibaru/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A launch-sniper bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun. It paper-trades pump.fun bonding curves on a 6-hour replay window (protocol `agent-fun/replay/v2`, Node 22), ranked by net PnL with a 10 SOL bankroll.

## Strategy

Most pump.fun curves die within minutes of launch; the few that run do it fast. So the bot buys **only fresh launches**, only in their first slots, and only when the opening tape looks honest:

- the creator's own buys stay under 0.3 SOL, at least 0.05 SOL of creator buying is present, and the creator has not sold anything yet;
- at most 3 distinct non-creator wallets bought in the opening slots;
- buys total at least twice sells, and no single non-creator sell exceeds 25% of the real SOL reserve;
- the price has risen at most 1.2x from the create price, and the curve still holds at least 1 SOL of real reserve;
- at least 2 trades have been seen before entry.

It leaves fast, whichever comes first: full take-profit at 2.0x with the whole position sold at once — there is no partial take-profit, so a runner stays in until the trailing stop or the full target takes it out — stop-loss at 0.95x, a trailing stop that arms once the price peaks at 1.3x and sells when it slips 10% below that peak, a creator sell while held, a stale tape (120 slots without a trade), or a hard 900-slot hold limit.

Sizing is ~0.05 SOL per coin, at most 5 open positions, at most 1 entry per coin. A fill-pacing guard splits buys into two pieces when round trips lag the pace the window implies, and a capped late probe (last stretch of the window, at most 6 trips, relaxed filters) keeps the run clearing the minimum bar of 20 coins x 0.01 SOL round trip with max drawdown at most 50%.

The bot is fully deterministic: every decision comes from the batch stream only — no clock, no randomness, no environment reads, no I/O — so two runs over the same batches produce byte-identical replies.

## How it runs

The grader runs `node main.ts`. `main.ts` is a thin entrypoint that hands the strategy to the vendored SDK (`vendor/agentfun-bot.ts`, the kit's `agent-fun/replay/v2` shim), which speaks the replay protocol on stdin/stdout: one `{"type":"reply","seq":N,"orders":[...]}` per batch. The strategy itself is in `strategy.ts` (`createStrategy(DEFAULT_PARAMS)`); all tunables live in `DEFAULT_PARAMS` at the top of that file.

## Files

- `main.ts` — thin entrypoint (Node 22, TypeScript as-is).
- `strategy.ts` — the launch-sniper strategy.
- `vendor/agentfun-bot.ts` — the kit's replay-protocol SDK, vendored byte-for-byte.
- `.makefun/owner.json` — claim file naming the payout wallet.
- `LICENSE` — MIT.

## License

MIT — see [LICENSE](LICENSE).
