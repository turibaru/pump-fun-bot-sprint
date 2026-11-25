// Pump.fun Bot Sprint — launch sniper (Node 22, agent-fun/replay/v2).
//
// Thin entrypoint: the wire protocol lives in the vendored SDK
// (./vendor/agentfun-bot.ts) and the whole strategy in ./strategy.ts.
import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
