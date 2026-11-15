// The token radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// pre-token protocols below the watchlist floor: the early rows the radar exists to find. A protocol
// is pre-token when its record carries no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart as the comps the value model is fitted on, and shown
// as the market's own values, never mixed into the ranked board.
//
// Implied value is fitted from the market, not from a flat multiple and never from a list of names:
//
//   comps      = every protocol whose token already trades (mcap_usd set, tvl_usd > 0)
//   multiple   = the median mcap / tvl of the comps in the protocol's own category,
//                or the median across all comps when the category holds fewer than five
//   base       = tvl_usd x multiple
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x 0.5
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied    = max(1, round(base x growthMult x maturity))
//
// The fit is tested out of sample before it is used: the comps are split in two by a deterministic
// hash of the slug, the multiples are re-fitted on one half, and the other half is predicted from
// TVL alone. The dashboard states the median error and the share predicted within twice the real
// market cap, so the reader can see how much the fit is worth. The board itself is scored with the
// multiples fitted on all the comps.
//
// Every farm plan is netted: each step carries what it costs and how long it takes, the gas is
// priced by the chain the protocol runs on, and the last step totals the gas and the capital locked
// and gives a verdict: farm, farm small, thin, or skip. A thin protocol is one whose modelled value
// is too small for the gas and time it asks for; the board says so instead of dressing it up.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  min_category_comps: number;
  capital_opportunity: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  min_category_comps: 5,
  capital_opportunity: 0.03,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 200;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's fitted multiple: the median mcap / tvl of its token protocols. */
export interface CategoryFit {
  category: string;
  multiple: number;
  comps: number;
  fallback: boolean;
}

/** The out-of-sample check: the fit re-made on half the comps, tested on the other half. */
export interface OutOfSample {
  held_out: number;
  median_ape_pct: number;
  within_2x_pct: number;
}

/** The whole comps fit: the global multiple, every category's, and the out-of-sample check. */
export interface CompsFit {
  comps: number;
  global_multiple: number;
  by_category: CategoryFit[];
  out_of_sample: OutOfSample;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A farm plan's verdict: farm it, farm it small, thin, or skip it. */
export type FarmVerdict = 'farm' | 'farm-small' | 'thin' | 'skip';

/** One row of board.json: the ranked board's row. */
/** How a protocol's last seven days read: a steep fall, a sharp surge, or nothing worth flagging. */
export type Risk = 'falling' | 'surging' | 'steady';

/** The risk flag from the seven-day change alone: a fall of 15% or more, a surge of 25% or more. */
export function riskFor(change7d: number | null): Risk {
  if (change7d === null || !Number.isFinite(change7d)) return 'steady';
  if (change7d <= -15) return 'falling';
  if (change7d >= 25) return 'surging';
  return 'steady';
}

/** One chain's share of the board: how many pre-token protocols live there, what they are worth together, and which one leads. */
export interface ChainAggregate {
  chain: string;
  protocols: number;
  total_implied_usd: number;
  farm_rows: number;
  top_slug: string;
  top_name: string;
  top_implied_usd: number;
}

/** The board grouped by chain, richest first. A protocol on several chains counts on each of them. */
export function chainAggregates(board: BoardRow[]): ChainAggregate[] {
  const byChain = new Map<string, { protocols: number; total: number; farm: number; top: BoardRow | null }>();
  for (const row of board) {
    for (const chain of row.chains) {
      const agg = byChain.get(chain) ?? { protocols: 0, total: 0, farm: 0, top: null };
      agg.protocols += 1;
      agg.total += row.implied_value_usd;
      if (row.farm_verdict === 'farm' || row.farm_verdict === 'farm-small') agg.farm += 1;
      if (agg.top === null || row.implied_value_usd > agg.top.implied_value_usd) agg.top = row;
      byChain.set(chain, agg);
    }
  }
  return [...byChain.entries()]
    .map(([chain, agg]) => ({
      chain,
      protocols: agg.protocols,
      total_implied_usd: agg.total,
      farm_rows: agg.farm,
      top_slug: agg.top?.slug ?? '',
      top_name: agg.top?.name ?? '',
      top_implied_usd: agg.top?.implied_value_usd ?? 0,
    }))
    .sort((a, b) => b.total_implied_usd - a.total_implied_usd || (a.chain < b.chain ? -1 : 1));
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    multiple_source: string;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_cost_usd: number;
  farm_gas_usd: number;
  farm_verdict: FarmVerdict;
  risk: Risk;
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_cost_usd: number;
  farm_gas_usd: number;
  farm_verdict: FarmVerdict;
  risk: Risk;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the fit, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  fit: CompsFit;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  chains: ChainAggregate[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted list of numbers; null when the list is empty. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A deterministic hash of a slug: the split below never moves between runs. */
function hashSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The comps fit: the median mcap / tvl of the protocols whose token already trades, per category
 * when the category holds enough comps, else the median across all of them. The out-of-sample check
 * re-fits the same rule on one deterministic half of the comps and predicts the other half from TVL
 * alone, so the reader sees the fit's error instead of taking it on trust.
 */
export function fitComps(snapshot: Snapshot, model: ModelConstants = MODEL): CompsFit {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0 && p.category !== 'CEX');
  const global = median(comps.map((p) => (p.mcap_usd as number) / p.tvl_usd).sort((a, b) => a - b)) ?? 0.25;

  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of comps) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key);
    if (list) list.push(p);
    else byCat.set(key, [p]);
  }
  const byCategory: CategoryFit[] = [...byCat.entries()]
    .map(([category, list]) => {
      const m = median(list.map((p) => (p.mcap_usd as number) / p.tvl_usd).sort((a, b) => a - b));
      if (list.length >= model.min_category_comps && m !== null) {
        return { category, multiple: m, comps: list.length, fallback: false };
      }
      return { category, multiple: global, comps: list.length, fallback: true };
    })
    .sort((a, b) => b.comps - a.comps || (a.category < b.category ? -1 : 1));

  // Out of sample: fit on the even half, predict the odd half, measure the error.
  const fitHalf = comps.filter((p) => hashSlug(p.slug) % 2 === 0);
  const testHalf = comps.filter((p) => hashSlug(p.slug) % 2 === 1);
  const fitGlobal = median(fitHalf.map((p) => (p.mcap_usd as number) / p.tvl_usd).sort((a, b) => a - b)) ?? global;
  const fitByCat = new Map<string, number>();
  const fitCatLists = new Map<string, number[]>();
  for (const p of fitHalf) {
    const key = p.category ?? 'Other';
    const list = fitCatLists.get(key) ?? [];
    list.push((p.mcap_usd as number) / p.tvl_usd);
    fitCatLists.set(key, list);
  }
  for (const [key, list] of fitCatLists) {
    const m = median(list.sort((a, b) => a - b));
    if (list.length >= model.min_category_comps && m !== null) fitByCat.set(key, m);
    else fitByCat.set(key, fitGlobal);
  }
  const apes: number[] = [];
  let within2x = 0;
  for (const p of testHalf) {
    const mult = fitByCat.get(p.category ?? 'Other') ?? fitGlobal;
    const predicted = p.tvl_usd * mult;
    const actual = p.mcap_usd as number;
    if (actual <= 0) continue;
    apes.push(Math.abs(predicted - actual) / actual);
    if (predicted >= actual / 2 && predicted <= actual * 2) within2x += 1;
  }
  apes.sort((a, b) => a - b);
  const outOfSample: OutOfSample = {
    held_out: apes.length,
    median_ape_pct: apes.length > 0 ? Math.round(((median(apes) ?? 0) * 100 + Number.EPSILON) * 10) / 10 : 0,
    within_2x_pct: apes.length > 0 ? Math.round((within2x / apes.length) * 1000) / 10 : 0,
  };
  return { comps: comps.length, global_multiple: global, by_category: byCategory, out_of_sample: outOfSample };
}

/** The fitted multiple for one protocol's category, and where it came from. */
function multipleFor(p: SnapshotProtocol, fit: CompsFit): { multiple: number; source: string } {
  const found = fit.by_category.find((c) => c.category === (p.category ?? 'Other'));
  if (found !== undefined && !found.fallback) return { multiple: found.multiple, source: `${p.category ?? 'Other'} median (${found.comps} comps)` };
  return { multiple: fit.global_multiple, source: `global median (${fit.comps} comps)` };
}

/** The three multipliers and the implied value one protocol gets under the fitted model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fit: CompsFit,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; source: string; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, source } = multipleFor(protocol, fit);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, multiple, source, growthPct, growthMult, maturityMult, age };
}

/** The gas of one transaction on a chain, in whole dollars: L2s are cheap, Ethereum is not. */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'solana' || c === 'sui' || c === 'aptos' || c === 'near') return 0.1;
  if (c === 'polygon' || c === 'bsc' || c === 'binance') return 0.3;
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'unichain' || c === 'ink' || c === 'worldchain' || c === 'abstract' || c === 'soneium' || c === 'zksync' || c === 'linea' || c === 'scroll' || c === 'blast' || c === 'mode' || c === 'fraxtal') return 0.5;
  if (c === 'ethereum') return 6;
  if (c === 'avalanche' || c === 'berachain' || c === 'sonic' || c === 'hyperliquid l1' || c === 'monad' || c === 'movement') return 0.5;
  if (c === 'tron') return 1;
  return 2;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The whole farm's gas: one setup transaction, one a week while holding, one to claim. */
function gasTotal(p: SnapshotProtocol, holdDays: number): number {
  const gas = gasPerTx(chainOf(p));
  const weeks = Math.max(1, Math.ceil(holdDays / 7));
  return Math.round((gas * (2 + weeks) + Number.EPSILON) * 100) / 100;
}

/** The farm's total cost: the gas plus the capital's opportunity cost over the hold. */
function farmCost(p: SnapshotProtocol, holdDays: number, model: ModelConstants): { cost: number; gas: number; capital: number } {
  const gas = gasTotal(p, holdDays);
  const capital = capitalFor(p);
  const cost = Math.round((gas + capital * model.capital_opportunity + Number.EPSILON) * 100) / 100;
  return { cost, gas, capital };
}

/** The verdict: what the modelled value is worth against the farm's cost, as a ratio. */
export function verdictFor(implied: number, cost: number): FarmVerdict {
  const ratio = implied / Math.max(1, cost);
  if (ratio >= 1_000_000) return 'farm';
  if (ratio >= 300_000) return 'farm-small';
  if (ratio >= 80_000) return 'thin';
  return 'skip';
}

const VERDICT_TEXT: Record<FarmVerdict, string> = {
  farm: 'Farm it: the model values this launch high enough to justify a real position.',
  'farm-small': 'Farm it small: worth a light position; keep the gas low by using its cheapest chain.',
  thin: 'Thin: only farm this if you already use the protocol; the expected value is thin against the gas.',
  skip: 'Skip it: the modelled value is too thin for the gas and the time; watch it instead.',
};

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, and the last one the
 * net: the gas and the capital the whole plan asks for, against the modelled value, with the verdict.
 * The plan is derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied: number, model: ModelConstants = MODEL): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const { cost, gas } = farmCost(p, hold, model);
  const verdict = verdictFor(implied, cost);
  const gasEach = gasPerTx(chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `about $${gasEach} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gasEach} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $${gasEach} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: `Net: about $${gas} of gas and $${capital} locked for ${hold} days to farm a protocol the model values at $${implied.toLocaleString('en-US')}. ${VERDICT_TEXT[verdict]}`,
      cost: `$${cost} all in, gas plus the capital's opportunity cost`,
      time: `${hold} days and about an hour of your time`,
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: CompsFit, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, multiple, source, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, fit, model);
    const hold = holdDaysFor(age);
    const { cost, gas } = farmCost(p, hold, model);
    return { p, implied, multiple, source, growthPct, growthMult, maturityMult, age, cost, gas, verdict: verdictFor(implied, cost) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      multiple: s.multiple,
      multiple_source: s.source,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_cost_usd: s.cost,
    farm_gas_usd: s.gas,
    farm_verdict: s.verdict,
    risk: riskFor(s.p.change_7d),
    farm_steps: farmSteps(s.p, s.age, s.implied, model).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_cost_usd: row.farm_cost_usd,
    farm_gas_usd: row.farm_gas_usd,
    farm_verdict: row.farm_verdict,
    risk: row.risk,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fit = fitComps(snapshot, model);
  const board = buildBoard(snapshot, fit, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    fit,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    chains: chainAggregates(board),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
