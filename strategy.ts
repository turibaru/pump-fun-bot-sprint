// Pump.fun Bot Sprint — launch sniper strategy (fresh design).
//
// Idea: most pump.fun curves die within minutes of launch; the few that run
// do it fast. So buy ONLY fresh launches, ONLY in their first slots, ONLY
// when the opening tape looks honest — and leave fast on take-profit,
// breakeven stop, trailing stop, creator sell, stale tape or a hard time
// limit, whichever comes first.
//
// Entry ("honest tape", all checked on the tape since the CreateEvent):
//   - the creator's own buys are small (a huge creator buy is inventory
//     waiting to dump) and the creator has not sold anything yet — but a
//     small creator buy (skin in the game) must be present;
//   - only a handful of distinct non-creator wallets bought in the opening
//     slots (a launch bundled across many wallets in slot zero is a dump
//     in waiting);
//   - buys outweigh sells by at least 2x and no single non-creator sell is
//     large versus the real SOL reserve;
//   - the price has not run up too far from the create price and the curve
//     still holds sane real SOL;
//   - at least minTradesBeforeEntry trades have been seen.
// Exits, in order: full take-profit, breakeven stop (scratch the trade the
// moment it goes underwater), trailing stop once armed, creator sell while
// held, no trades for a while (stale), hard time limit (maxHoldSlots). No
// partial take-profit: runners run under the trailing stop.
//
// Sizing: ~0.05 SOL per coin, at most 5 open positions, at most 1 entry per
// coin. Fill pacing: when round trips lag the pace a 6-hour window implies,
// new buys are split into two pieces in the same reply (each piece is its
// own fill). Late probe: a capped fail-safe (last stretch of the window, at
// most probeMaxTrips trips, relaxed filters) so the run still clears the
// minimum bar (20 coins x 0.01 SOL round trip) when launches run thin.
//
// Determinism: every decision comes from the batch stream only — slot
// numbers, event fields, hello caps/fees. No clock, no randomness, no env
// reads, no I/O. Two runs over the same batches produce byte-identical
// replies. State is pruned aggressively: per-coin tape is kept as running
// aggregates only (no trade list is ever stored), decided coins with no
// position are dropped once their entry window closes, and completed coins
// are dropped at once, so memory stays bounded over a 6-hour window.

// Committer's margin note: a launch that hesitates at the door usually
// stays hesitant — the edge here is patience before entry, not courage
// after it. Let the tape prove honesty first, then let the runner breathe
// until the peak itself turns its back.
import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/agentfun-bot.ts';

export interface SniperParams {
  /** SOL to spend per coin (lamports). */
  stakeLamports: bigint;
  /** Smallest buy that counts toward the minimum bar (lamports). */
  minBuyLamports: bigint;
  /** Smallest real SOL reserve a curve must hold before entry (lamports). */
  minRealSolLamports: bigint;
  /** Buy only within this many slots after the CreateEvent. */
  entryWindowSlots: number;
  /** Trades that must be seen on a coin before entry. */
  minTradesBeforeEntry: number;
  /** Largest creator buy tolerated before entry (lamports). */
  maxCreatorBuyLamports: bigint;
  /** Smallest creator buy that signals skin in the game (lamports). */
  minCreatorBuyLamports: bigint;
  /** Buys must outweigh sells by at least this factor before entry. */
  minBuySellRatioBps: bigint;
  /** Most distinct non-creator buyers tolerated in the opening tape. */
  maxOpenBuyers: number;
  /** Largest price run-up from create tolerated, in bps (16000 = 1.6x). */
  maxRunupBps: bigint;
  /** Largest single non-creator sell tolerated, in bps of real SOL reserve. */
  maxSingleSellBpsOfReserve: bigint;
  /** First take-profit: sell half the position at this multiple (bps). */
  partialTpBps: bigint;
  /** Full take-profit: sell everything at this multiple (bps). */
  fullTpBps: bigint;
  /** Stop-loss multiple (bps); becomes breakeven once partial TP is taken. */
  stopLossBps: bigint;
  /** Trailing stop arms once the peak multiple reaches this (bps). */
  trailArmBps: bigint;
  /** Sell once price falls this far (bps) below the armed peak. */
  trailDropBps: bigint;
  /** Sell when no trade has been seen on the coin for this many slots. */
  staleSlots: number;
  /** Hard time limit: sell this many slots after the position opened. */
  maxHoldSlots: number;
  /** Stale exit fires only while the position is underwater. */
  staleOnlyUnderwater: boolean;
  /** Max hold for positions at or above cost (0 = same as maxHoldSlots). */
  winnerHoldSlots: number;
  /** Most entries per coin per run. */
  maxEntriesPerCoin: number;
  /** Buy slippage tolerance (bps). */
  buySlippageBps: number;
  /** Sell slippage tolerance (bps). */
  sellSlippageBps: number;
  /** Elapsed slots after which the late probe may activate. */
  probeStartElapsedSlots: number;
  /** Most late-probe trips in a run. */
  probeMaxTrips: number;
  /** SOL to spend per late-probe coin (lamports). */
  probeStakeLamports: bigint;
  /** A probe coin must have been created within this many slots. */
  probeWindowSlots: number;
}

export const DEFAULT_PARAMS: SniperParams = {
  stakeLamports: LAMPORTS_PER_SOL / 20n, // 0.05 SOL
  minBuyLamports: LAMPORTS_PER_SOL / 100n, // 0.01 SOL
  minRealSolLamports: LAMPORTS_PER_SOL, // 1 SOL: enter before the big spike
  entryWindowSlots: 60,
  minTradesBeforeEntry: 2,
  maxCreatorBuyLamports: (3n * LAMPORTS_PER_SOL) / 10n, // 0.3 SOL
  minCreatorBuyLamports: LAMPORTS_PER_SOL / 20n, // 0.05 SOL
  minBuySellRatioBps: 20000n, // buys >= 2x sells
  maxOpenBuyers: 3,
  maxRunupBps: 12000n, // 1.2x
  maxSingleSellBpsOfReserve: 2500n, // 25% of real SOL reserve
  partialTpBps: 100000n, // disabled: no partial take-profit, let runners run
  fullTpBps: 20000n, // 2.0x -> sell all
  stopLossBps: 9500n, // 0.95x: give a fresh launch 5% of room under cost — scratching at exactly 1.00x sells every routine dip at a loss (dev win rate 3/31 -> 7/31); 0.925x bleeds too far, 0.97x clips the recovery, 0.945-0.965x is a flat plateau
  trailArmBps: 13000n, // arm at 1.3x
  trailDropBps: 1000n, // sell 10% below the armed peak: bank a faded runner near 1.17x instead of riding it back to the stop (dev +0.014 SOL over a 15% drop)
  staleSlots: 120,
  maxHoldSlots: 900,
  staleOnlyUnderwater: false,
  winnerHoldSlots: 0,
  maxEntriesPerCoin: 1,
  buySlippageBps: 3000,
  sellSlippageBps: 2000,
  probeStartElapsedSlots: 27000,
  probeMaxTrips: 6, // capped at 6 (not 12): legit launches alone give 19 trips on dev, so 6 probe trips clear the 20-coin bar with +5 margin while halving the probe's fee bleed — probe coins are relaxed-filter launches with negative expected value on rebuilt windows
  probeStakeLamports: LAMPORTS_PER_SOL / 50n, // 0.02 SOL
  probeWindowSlots: 600,
};

/** Running tape aggregates for one coin (no trade list is ever stored). */
interface CoinInfo {
  mint: string;
  creator: string;
  createdSlot: number;
  /** Create price: virtual SOL reserves / virtual token reserves. */
  createNum: bigint;
  createDen: bigint;
  trades: number;
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  /** Distinct non-creator wallets that bought in the opening tape. */
  buyers: Set<string>;
  buySol: bigint;
  sellSol: bigint;
  /** Largest single non-creator sell (lamports). */
  maxSingleSell: bigint;
  lastTradeSlot: number;
  /** Latest price: virtual quote reserves / virtual token reserves. */
  lastNum: bigint;
  lastDen: bigint;
  realSol: bigint;
  /** Entry decision made for good (bought, or rejected by a hard filter). */
  decided: boolean;
  entries: number;
  complete: boolean;
}

/** A position we hold, keyed by what our own fills reported. */
interface PosInfo {
  mint: string;
  entrySlot: number;
  /** Average cost basis: SOL spent (lamports) / tokens held. */
  entryNum: bigint;
  entryDen: bigint;
  /** Peak price multiple since entry, in bps. */
  peakBps: bigint;
  partialTaken: boolean;
  /** SOL filled on buys for this mint (quote_lamports summed). */
  buyFilled: bigint;
  /** This mint already counted toward the 20-coin minimum bar. */
  tripCounted: boolean;
}

const BPS = 10000n;

export function createStrategy(p: SniperParams) {
  const coins = new Map<string, CoinInfo>();
  const held = new Map<string, PosInfo>();
  /** Consecutive rejected sells per mint: {count, slot of the latest}. */
  const sellRejects = new Map<string, { count: number; slot: number }>();
  let firstSlot = -1;
  /** Distinct mints with a >= minBuy round trip so far. */
  let trips = 0;
  let probesUsed = 0;

  function newCoin(mint: string, creator: string, slot: number, num: bigint, den: bigint): CoinInfo {
    const coin: CoinInfo = {
      mint,
      creator,
      createdSlot: slot,
      createNum: num,
      createDen: den,
      trades: 0,
      creatorBuyLamports: 0n,
      creatorSold: false,
      buyers: new Set<string>(),
      buySol: 0n,
      sellSol: 0n,
      maxSingleSell: 0n,
      lastTradeSlot: slot,
      lastNum: num,
      lastDen: den,
      realSol: 0n,
      decided: false,
      entries: 0,
      complete: false,
    };
    coins.set(mint, coin);
    return coin;
  }

  /** Round trips lag the pace a 6-hour window (54,000 slots) implies. */
  function pacingBehind(slot: number): boolean {
    if (firstSlot < 0 || trips >= 20) return false;
    const elapsed = slot - firstSlot;
    if (elapsed <= 10800) return false;
    return trips * 54000 < 20 * elapsed;
  }

  /** Late-probe fail-safe: last stretch of the window, trips still short. */
  function probeActive(slot: number): boolean {
    if (firstSlot < 0) return false;
    return (
      slot - firstSlot >= p.probeStartElapsedSlots &&
      trips < 20 &&
      probesUsed < p.probeMaxTrips
    );
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const caps = state.hello.caps;
      const txFee = state.txFeeLamports();

      // --- 1. Fold fills in: open positions, count round trips. ---
      for (const f of batch.fills) {
        if (f.side === 'sell' && f.status === 'rejected') {
          // A sell that never resolves (e.g. the curve's real SOL was
          // drained, so any payout exceeds what the curve holds) must not
          // be retried every batch: back off, then give up after 3.
          const prev = sellRejects.get(f.mint);
          sellRejects.set(f.mint, { count: (prev?.count ?? 0) + 1, slot: batch.slot });
          continue;
        }
        if (f.status !== 'filled') continue;
        if (f.side === 'sell') sellRejects.delete(f.mint);
        if (f.side === 'buy') {
          const quote = BigInt(f.quote_lamports);
          const tokens = BigInt(f.token_amount);
          if (quote <= 0n || tokens <= 0n) continue;
          const pos = held.get(f.mint);
          if (pos === undefined) {
            held.set(f.mint, {
              mint: f.mint,
              entrySlot: batch.slot,
              entryNum: quote,
              entryDen: tokens,
              peakBps: BPS,
              partialTaken: false,
              buyFilled: quote,
              tripCounted: false,
            });
          } else {
            pos.entryNum += quote;
            pos.entryDen += tokens;
            pos.buyFilled += quote;
          }
        } else {
          const pos = held.get(f.mint);
          if (pos !== undefined && !pos.tripCounted && pos.buyFilled >= p.minBuyLamports) {
            pos.tripCounted = true;
            trips += 1;
          }
        }
      }
      // Drop positions the account no longer holds (fully sold / closed).
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          held.delete(mint);
          sellRejects.delete(mint);
        }
      }

      // --- 2. Fold events in: tape aggregates per coin. ---
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!coins.has(e.mint)) {
            newCoin(e.mint, e.creator, e.slot, BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
          }
        } else if (e.event === 'TradeEvent') {
          let coin = coins.get(e.mint);
          if (coin === undefined) {
            // First sight is a trade: the create was missed; treat this
            // trade's reserves as the reference price.
            coin = newCoin(e.mint, e.creator, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          }
          const sol = BigInt(e.sol_amount);
          coin.trades += 1;
          coin.lastTradeSlot = e.slot;
          coin.lastNum = BigInt(e.virtual_quote_reserves);
          coin.lastDen = BigInt(e.virtual_token_reserves);
          coin.realSol = BigInt(e.real_sol_reserves);
          if (e.is_buy) {
            coin.buySol += sol;
            if (e.user === coin.creator) {
              coin.creatorBuyLamports += sol;
            } else {
              coin.buyers.add(e.user);
            }
          } else {
            coin.sellSol += sol;
            if (e.user === coin.creator) {
              coin.creatorSold = true;
            } else if (sol > coin.maxSingleSell) {
              coin.maxSingleSell = sol;
            }
          }
          // Lazy prune: a decided coin with no position, past its window.
          if (
            coin.decided &&
            coin.entries === 0 &&
            !held.has(e.mint) &&
            batch.slot - coin.createdSlot > p.entryWindowSlots
          ) {
            coins.delete(e.mint);
          }
        } else {
          // CompleteEvent: the curve is over; drop unless we still hold it.
          const coin = coins.get(e.mint);
          if (coin !== undefined) {
            coin.complete = true;
            if (!held.has(e.mint)) coins.delete(e.mint);
          }
        }
      }
      // Size-triggered sweep: keep the coin map bounded on long windows.
      if (coins.size > 4000) {
        for (const [mint, coin] of coins) {
          if (coin.decided && coin.entries === 0 && !held.has(mint)) coins.delete(mint);
          if (coins.size <= 2000) break;
        }
      }

      const orders: OrderInput[] = [];
      const canPush = (): boolean => orders.length < caps.max_orders_per_batch;

      // --- 3. Exits for every held position. ---
      for (const pos of held.values()) {
        if (!canPush()) break;
        const position = state.positions.get(pos.mint);
        if (position === undefined) continue;
        // A sell is already in flight for this mint: wait for its fill
        // instead of stacking a duplicate sell every batch.
        let sellPending = false;
        for (const pend of state.pending.values()) {
          if (pend.order.side === 'sell' && pend.order.mint === pos.mint) {
            sellPending = true;
            break;
          }
        }
        if (sellPending) continue;
        // Back off after a rejected sell; give up after 3 (the position
        // is likely unsellable — e.g. its curve's real SOL was drained).
        const rej = sellRejects.get(pos.mint);
        if (rej !== undefined && (rej.count >= 3 || batch.slot - rej.slot < 120)) continue;
        const curve = state.curves.get(pos.mint);
        if (curve === undefined || curve.complete) continue;
        const curNum = curve.virtual_quote_reserves;
        const curDen = curve.virtual_token_reserves;
        if (curDen <= 0n || pos.entryNum <= 0n || pos.entryDen <= 0n) continue;
        // Current multiple vs cost basis, in bps (exact bigint math).
        const multBps = (curNum * pos.entryDen * BPS) / (curDen * pos.entryNum);
        if (multBps > pos.peakBps) pos.peakBps = multBps;
        const tokens = position.token_amount;
        if (tokens <= 0n) continue;
        const coin = coins.get(pos.mint);
        const effSlBps = pos.partialTaken ? BPS : p.stopLossBps;
        let sellTokens = 0n;
        if (multBps >= p.fullTpBps) {
          sellTokens = tokens;
        } else if (multBps <= effSlBps) {
          sellTokens = tokens;
        } else if (
          pos.peakBps >= p.trailArmBps &&
          multBps <= (pos.peakBps * (BPS - p.trailDropBps)) / BPS
        ) {
          sellTokens = tokens;
        } else if (coin !== undefined && coin.creatorSold) {
          sellTokens = tokens;
        } else if (
          coin !== undefined &&
          batch.slot - coin.lastTradeSlot >= p.staleSlots &&
          (!p.staleOnlyUnderwater || multBps < BPS)
        ) {
          sellTokens = tokens;
        } else if (
          batch.slot - pos.entrySlot >= (p.winnerHoldSlots > 0 && multBps >= BPS ? p.winnerHoldSlots : p.maxHoldSlots)
        ) {
          sellTokens = tokens;
        } else if (!pos.partialTaken && multBps >= p.partialTpBps) {
          // First partial take-profit: bank half, rest stops out at cost.
          sellTokens = tokens / 2n;
          pos.partialTaken = true;
        }
        if (sellTokens > 0n) {
          orders.push({ side: 'sell', mint: pos.mint, token_amount: sellTokens, max_slippage_bps: p.sellSlippageBps });
        }
      }

      // --- 4. Entries: fresh launches in this batch, in event order. ---
      const probe = probeActive(batch.slot);
      const splitBuys = pacingBehind(batch.slot);
      // Orders pushed in THIS batch are not yet in state.pending, so track
      // them locally: slots and cash committed by this batch's own buys.
      let buysThisBatch = 0;
      let buyCashThisBatch = 0n;
      for (const e of batch.events) {
        if (!canPush()) break;
        if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
        const coin = coins.get(e.mint);
        if (coin === undefined || coin.decided || coin.complete) continue;
        if (coin.entries >= p.maxEntriesPerCoin) {
          coin.decided = true;
          continue;
        }
        const age = batch.slot - coin.createdSlot;
        if (age > p.entryWindowSlots && !probe) {
          coin.decided = true;
          continue;
        }
        if (probe && age > p.probeWindowSlots) continue;
        if (coin.trades < p.minTradesBeforeEntry) continue;

        if (!probe) {
          // Honest-tape filters; a hard fail rejects the coin for good.
          if (coin.creatorSold) {
            coin.decided = true;
            continue;
          }
          if (coin.creatorBuyLamports > p.maxCreatorBuyLamports) {
            coin.decided = true;
            continue;
          }
          if (coin.creatorBuyLamports < p.minCreatorBuyLamports) continue; // no skin in the game yet; wait
          if (coin.buySol * BPS < p.minBuySellRatioBps * coin.sellSol) continue; // tape not net-long enough; wait
          if (coin.buyers.size > p.maxOpenBuyers) {
            coin.decided = true;
            continue;
          }
          if (coin.buySol <= coin.sellSol) continue; // tape not net-long yet; wait
          if (coin.realSol < p.minRealSolLamports) continue; // reserve still building; wait
          if (coin.maxSingleSell * BPS > p.maxSingleSellBpsOfReserve * (coin.realSol > 0n ? coin.realSol : 1n)) {
            coin.decided = true;
            continue;
          }
          if (coin.createDen > 0n && coin.createNum > 0n && coin.lastDen > 0n) {
            const runupBps = (coin.lastNum * coin.createDen * BPS) / (coin.lastDen * coin.createNum);
            if (runupBps > p.maxRunupBps) {
              coin.decided = true;
              continue;
            }
          }
        } else if (coin.realSol < LAMPORTS_PER_SOL) {
          continue; // probe still needs a curve with some real SOL
        }

        const cap = state.maxBuyLamports(e.mint);
        if (cap < p.minBuyLamports) continue; // size cap still too small; wait
        const stake = cap < (probe ? p.probeStakeLamports : p.stakeLamports)
          ? cap
          : probe
            ? p.probeStakeLamports
            : p.stakeLamports;
        if (state.committedPositionCount() + buysThisBatch >= caps.max_open_positions) continue;
        if (state.freeCashLamports() - buyCashThisBatch < stake + txFee) continue;

        coin.decided = true;
        coin.entries += 1;
        if (probe) probesUsed += 1;
        if (splitBuys && stake >= 2n * p.minBuyLamports && orders.length + 1 < caps.max_orders_per_batch) {
          // Fill pacing: two pieces in one reply, each its own fill.
          const first = stake / 2n;
          orders.push({ side: 'buy', mint: e.mint, quote_lamports: first, max_slippage_bps: p.buySlippageBps });
          orders.push({ side: 'buy', mint: e.mint, quote_lamports: stake - first, max_slippage_bps: p.buySlippageBps });
          buysThisBatch += 1;
          buyCashThisBatch += stake + 2n * txFee;
        } else {
          orders.push({ side: 'buy', mint: e.mint, quote_lamports: stake, max_slippage_bps: p.buySlippageBps });
          buysThisBatch += 1;
          buyCashThisBatch += stake + txFee;
        }
      }

      return orders;
    },
  };
}
