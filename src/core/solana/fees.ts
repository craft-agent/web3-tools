import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { compileLegacyMessage, unsignedTransactionBase64, type SolanaMessage } from "./message"
import { recentPriorityFees, simulate } from "./reads"

/** The compute budget a message sets for itself: the units it may use and the micro-lamports it pays for each. */
export type ComputeBudget = { unitLimit: number; unitPrice: bigint }

/** What the cluster asks to land a message now, and what leaves room for it to rise. Amounts are in lamports. */
export type SolanaFeeQuote = {
  /** The name of the cluster the quote is for. */
  cluster: string
  /** The compute units the simulated message consumed. */
  unitsConsumed: number
  /** The limit to set: the units consumed and a tenth more. */
  unitLimit: number
  /** Micro-lamports per compute unit: the 75th percentile of the non-zero prices recent blocks paid; 0 when none paid one. */
  unitPrice: bigint
  /** The signature fee: 5000 lamports for each signature. */
  baseFee: bigint
  /** `baseFee + ceil(unitPrice × unitLimit / 1e6)`: what the cluster asks now. */
  needed: bigint
  /** The base fee and a priority fee at twice the price, or at 1000 micro-lamports when that is more: a `max_fee` with headroom. */
  suggested: bigint
}

/** The most compute units a transaction may use, which the simulation is given. */
export const MAX_UNIT_LIMIT = 1_400_000

/** The signatures of the transactions these tools send: the fee payer's alone. */
const SIGNATURES = 1n

/** The lamports the cluster charges for each signature. */
export const LAMPORTS_PER_SIGNATURE = 5000n

/** Micro-lamports in a lamport, which a unit price is counted in. */
export const MICRO_LAMPORTS = 1_000_000n

/** The margin on the units consumed, as a ratio: 11/10. */
const LIMIT_MARGIN = { numerator: 11, denominator: 10 }

/** The units the two compute budget instructions take, when the simulation did not count them. */
const BUDGET_INSTRUCTION_UNITS = 300

/** The percentile of recent prices the quote takes, as a ratio: 3/4. */
const PRICE_PERCENTILE = { numerator: 3, denominator: 4 }

/** How many unit prices `suggested` leaves room for. */
const PRICE_HEADROOM = 2n

/**
 * The price, in micro-lamports per unit, that `suggested` assumes at least. With no recent priority fee a doubled price
 * would add nothing, so the suggestion would be no more than the fee asked now and any rise would fail the call as stale.
 */
const MIN_HEADROOM_PRICE = 1000n

/** The lamports of the priority fee for a price in micro-lamports per unit and a limit in units, rounded up as the cluster does. */
export function priorityFee(unitPrice: bigint, unitLimit: number): bigint {
  return (unitPrice * BigInt(unitLimit) + MICRO_LAMPORTS - 1n) / MICRO_LAMPORTS
}

/** The limit to set for a message that consumed `unitsConsumed`: a tenth more, and at least the two budget instructions more, up to the most. */
function limitFor(unitsConsumed: number): number {
  const { numerator, denominator } = LIMIT_MARGIN
  const margined = Math.ceil((unitsConsumed * numerator) / denominator)
  return Math.min(Math.max(margined, unitsConsumed + BUDGET_INSTRUCTION_UNITS), MAX_UNIT_LIMIT)
}

/** The 75th percentile (nearest rank) of the non-zero `prices`; 0 when there are none. */
function pricePercentile(prices: readonly bigint[]): bigint {
  const paid = prices.filter((price) => price > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (paid.length === 0) return 0n
  const { numerator, denominator } = PRICE_PERCENTILE
  return paid[Math.ceil((paid.length * numerator) / denominator) - 1]
}

/**
 * What the cluster asks to land the message `build` makes, which writes to `writable`. `build` is called with a budget
 * and returns the message, with its compute budget instructions set from it. It is simulated first with the most
 * units and a price of 0 to read what it consumes; the limit is that plus a tenth (and at least the two budget
 * instructions more, and at most 1.4 million units). The price is the 75th percentile of the non-zero prices recent
 * blocks paid for the `writable` accounts, 0 when none paid one. A message the cluster would fail is `invalid_argument`.
 */
export async function quoteSolanaFees(
  client: JsonRpcClient,
  build: (budget: ComputeBudget) => SolanaMessage,
  writable: readonly string[],
): Promise<SolanaFeeQuote> {
  const probe = build({ unitLimit: MAX_UNIT_LIMIT, unitPrice: 0n })
  const unsigned = unsignedTransactionBase64(compileLegacyMessage(probe))
  const [{ unitsConsumed }, prices] = await Promise.all([
    simulate(client, unsigned),
    recentPriorityFees(client, writable),
  ])
  const unitLimit = limitFor(unitsConsumed)
  const unitPrice = pricePercentile(prices)
  const baseFee = LAMPORTS_PER_SIGNATURE * SIGNATURES
  const doubled = PRICE_HEADROOM * unitPrice
  return {
    cluster: client.name,
    unitsConsumed,
    unitLimit,
    unitPrice,
    baseFee,
    needed: baseFee + priorityFee(unitPrice, unitLimit),
    suggested: baseFee + priorityFee(doubled > MIN_HEADROOM_PRICE ? doubled : MIN_HEADROOM_PRICE, unitLimit),
  }
}

/**
 * The compute budget to sign with so that the transaction costs at most `maxFee`: the quote's limit and the largest
 * price whose priority fee fits what is left of `maxFee` after the base fee, but never above twice the quote's price.
 * A `maxFee` below what the cluster asks now is `stale`, and nothing may be sent.
 */
export function capSolanaFees(quote: SolanaFeeQuote, maxFee: bigint): ComputeBudget {
  if (maxFee < quote.needed) {
    throw new ToolError(
      "stale",
      `Network fees on ${quote.cluster} now need at least ${quote.needed} lamports; max_fee is ${maxFee}. Nothing was sent.`,
    )
  }
  const room = maxFee - quote.baseFee
  const affordable = (room * MICRO_LAMPORTS) / BigInt(quote.unitLimit)
  const ceiling = PRICE_HEADROOM * quote.unitPrice
  return { unitLimit: quote.unitLimit, unitPrice: affordable < ceiling ? affordable : ceiling }
}

/** The refusal for a `max_fee` below what the cluster asks now (for `describe` and `gate`), or `undefined` when it is enough. */
export function solanaFeeShortfall(quote: SolanaFeeQuote, maxFee: bigint): ToolError | undefined {
  if (maxFee >= quote.needed) return undefined
  return new ToolError(
    "invalid_argument",
    `max_fee ${maxFee} lamports is below the ${quote.needed} lamports the network asks now on ${quote.cluster}; ${quote.suggested} lamports leaves room for the fee to rise.`,
  )
}
