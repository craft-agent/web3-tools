import { FEE_ORACLES, type EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import type { JsonRpcClient } from "../rpc/client"
import { isPlainObject } from "../rpc/mask"
import { bytesOfHex, readWord, WORD_BYTES } from "./abi"
import {
  callParams,
  callView,
  estimateGas,
  latestBaseFee,
  parseQuantity,
  priorityFee,
  revertRefusalOf,
  type EvmCall,
} from "./reads"
import {
  placeholderSignedEvmTransactionHex,
  unsignedEvmTransactionHex,
  type EvmTransactionRequest,
} from "./transaction"
import { getL1FeeCall, getOperatorFeeCall, TOKEN_RATIO_CALL } from "./views"

export type { EvmCall } from "./reads"

/** What the network asks to send `call` now, and what leaves room for it to rise. Amounts are in wei (the native coin's smallest unit). */
export type FeeQuote = {
  /** The name of the chain the quote is for. */
  chain: string
  gasLimit: bigint
  /** Per gas, now. */
  baseFee: bigint
  /** Per gas, now. */
  priorityFee: bigint
  /** `2 × baseFee + priorityFee`. */
  maxFeePerGas: bigint
  /** The margined L1 data fee in the native coin; 0 for `gas` and `linea`. */
  l1Fee: bigint
  /** 0 where the chain charges none. */
  operatorFee: bigint
  /** `gasLimit × (baseFee + priorityFee) + l1Fee + operatorFee`: what the network asks now. */
  needed: bigint
  /** `gasLimit × maxFeePerGas + l1Fee + operatorFee`: a `max_fee` with headroom. */
  suggested: bigint
}

/** The fees a transaction can be signed with under a `max_fee`. */
export type CappedFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

/** The gas of a transfer of the native coin to an account: the estimate stays as it is, with no margin. */
const PLAIN_TRANSFER_GAS = 21_000n

/** The margin on a gas estimate, as a ratio: 12/10. */
const GAS_MARGIN = { numerator: 12n, denominator: 10n }

/** The margin on an L1 data fee, which moves with L1's gas price between the quote and the block. */
const L1_MARGIN = 2n

/** How many base fees `maxFeePerGas` leaves room for. */
const BASE_FEE_HEADROOM = 2n

type DataFees = { l1Fee: bigint; operatorFee: bigint }

const NO_DATA_FEES: DataFees = { l1Fee: 0n, operatorFee: 0n }

function unreadable(chain: EvmChain, what: string, cause?: unknown): ToolError {
  return new ToolError("upstream_error", `The chain's ${what} could not be read; try again (${chain.name}).`, { cause })
}

/** The estimate with a margin of 20% rounded up, except that a plain transfer's 21000 is exact. */
function marginedGas(estimate: bigint): bigint {
  if (estimate === PLAIN_TRANSFER_GAS) return estimate
  const { numerator, denominator } = GAS_MARGIN
  return (estimate * numerator + denominator - 1n) / denominator
}

function checkedGasLimit(client: JsonRpcClient, gasLimit: bigint, what: string): bigint {
  if (gasLimit < PLAIN_TRANSFER_GAS) {
    throw new ToolError(
      "upstream_error",
      `${client.name} answered ${what} with a gas limit below ${PLAIN_TRANSFER_GAS}.`,
    )
  }
  return gasLimit
}

type Market = { gasLimit: bigint; baseFee: bigint; priorityFee: bigint }

async function lineaMarket(client: JsonRpcClient, call: EvmCall): Promise<Market> {
  let answer: unknown
  try {
    answer = await client.call("linea_estimateGas", [callParams(call)])
  } catch (error) {
    throw revertRefusalOf(error) ?? error
  }
  if (!isPlainObject(answer)) {
    throw new ToolError(
      "upstream_error",
      `${client.name} answered linea_estimateGas with something that is not an estimate.`,
    )
  }
  return {
    gasLimit: checkedGasLimit(
      client,
      parseQuantity(client, answer.gasLimit, "linea_estimateGas gasLimit"),
      "linea_estimateGas",
    ),
    baseFee: parseQuantity(client, answer.baseFeePerGas, "linea_estimateGas baseFeePerGas"),
    priorityFee: parseQuantity(client, answer.priorityFeePerGas, "linea_estimateGas priorityFeePerGas"),
  }
}

async function gasMarket(client: JsonRpcClient, call: EvmCall): Promise<Market> {
  const [estimate, baseFee, tip] = await Promise.all([
    estimateGas(client, call),
    latestBaseFee(client),
    priorityFee(client),
  ])
  return { gasLimit: marginedGas(checkedGasLimit(client, estimate, "eth_estimateGas")), baseFee, priorityFee: tip }
}

/**
 * One word an oracle answers. A revert returns `onRevert` when it is given; every other failure of the node, a
 * revert without `onRevert` and an answer shorter than a word are `upstream_error`.
 */
async function oracleWord(
  client: JsonRpcClient,
  chain: EvmChain,
  oracle: string,
  data: string,
  what: string,
  onRevert?: bigint,
): Promise<bigint> {
  let answer
  try {
    answer = await callView(client, oracle, data)
  } catch (error) {
    if (error instanceof ToolError && error.code === "upstream_error") throw unreadable(chain, what, error)
    throw error
  }
  if (answer.reverted) {
    if (onRevert !== undefined) return onRevert
    throw unreadable(chain, what)
  }
  const bytes = bytesOfHex(answer.data)
  if (!bytes || bytes.length < WORD_BYTES) throw unreadable(chain, what)
  return readWord(bytes, 0)
}

async function dataFees(client: JsonRpcClient, chain: EvmChain, request: EvmTransactionRequest): Promise<DataFees> {
  switch (chain.fee) {
    case "gas":
    case "linea":
      return NO_DATA_FEES
    case "op": {
      const oracle = FEE_ORACLES.op
      const unsigned = getL1FeeCall(unsignedEvmTransactionHex(request))
      const l1Fee = await oracleWord(client, chain, oracle, unsigned, "L1 data fee")
      const operatorFee = await oracleWord(
        client,
        chain,
        oracle,
        getOperatorFeeCall(request.gasLimit),
        "operator fee",
        0n,
      )
      return { l1Fee: l1Fee * L1_MARGIN, operatorFee }
    }
    case "mantle": {
      const oracle = FEE_ORACLES.mantle
      const unsigned = getL1FeeCall(unsignedEvmTransactionHex(request))
      const l1Fee = await oracleWord(client, chain, oracle, unsigned, "L1 data fee")
      const ratio = await oracleWord(client, chain, oracle, TOKEN_RATIO_CALL, "token ratio")
      const operatorFee = await oracleWord(client, chain, oracle, getOperatorFeeCall(request.gasLimit), "operator fee")
      return { l1Fee: l1Fee * ratio * L1_MARGIN, operatorFee }
    }
    case "scroll": {
      const signed = getL1FeeCall(placeholderSignedEvmTransactionHex(request))
      const l1Fee = await oracleWord(client, chain, FEE_ORACLES.scroll, signed, "L1 data fee")
      return { l1Fee: l1Fee * L1_MARGIN, operatorFee: 0n }
    }
  }
}

/**
 * What the network asks to send `call` now on `chain`, for the transaction that `nonce` would make. The gas
 * limit is the node's estimate with a margin of 20% (a plain transfer's 21000 stays exact; Linea's own estimate
 * has none); `maxFeePerGas` leaves room for two base fees; the L1 data fee and the operator fee come from the
 * chain's oracle (see `FeeModel`), the L1 fee doubled. A call the chain would revert is `invalid_argument`; an
 * oracle that cannot be read is `upstream_error`.
 */
export async function quoteFees(
  client: JsonRpcClient,
  chain: EvmChain,
  call: EvmCall,
  nonce: bigint,
): Promise<FeeQuote> {
  const {
    gasLimit,
    baseFee,
    priorityFee: tip,
  } = await (chain.fee === "linea" ? lineaMarket(client, call) : gasMarket(client, call))
  const maxFeePerGas = BASE_FEE_HEADROOM * baseFee + tip
  const { l1Fee, operatorFee } = await dataFees(client, chain, {
    chainId: chain.chainId,
    to: call.to,
    value: call.value,
    data: call.data,
    nonce,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: tip,
  })
  return {
    chain: chain.name,
    gasLimit,
    baseFee,
    priorityFee: tip,
    maxFeePerGas,
    l1Fee,
    operatorFee,
    needed: gasLimit * (baseFee + tip) + l1Fee + operatorFee,
    suggested: gasLimit * maxFeePerGas + l1Fee + operatorFee,
  }
}

/**
 * The fees to sign with so that the transaction costs at most `maxFee`: what is left of it after the L1 and
 * operator fees, per gas, but never above the quote's `maxFeePerGas`. A `maxFee` below what the network asks now
 * is `stale`, and nothing may be sent.
 */
export function capFees(quote: FeeQuote, maxFee: bigint): CappedFees {
  if (maxFee < quote.needed) {
    throw new ToolError(
      "stale",
      `Network fees on ${quote.chain} now need at least ${quote.needed} wei; max_fee is ${maxFee}. Nothing was sent.`,
    )
  }
  const room = (maxFee - quote.l1Fee - quote.operatorFee) / quote.gasLimit
  const maxFeePerGas = room < quote.maxFeePerGas ? room : quote.maxFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas: quote.priorityFee < maxFeePerGas ? quote.priorityFee : maxFeePerGas }
}

/** The refusal for a `max_fee` below what the network asks now (for `describe` and `gate`), or `undefined` when it is enough. */
export function feeShortfall(quote: FeeQuote, maxFee: bigint): ToolError | undefined {
  if (maxFee >= quote.needed) return undefined
  return new ToolError(
    "invalid_argument",
    `max_fee ${maxFee} wei is below the ${quote.needed} wei the network asks now on ${quote.chain}; ${quote.suggested} wei leaves room for the fee to rise.`,
  )
}
