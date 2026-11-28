import { secp256k1 } from "@noble/curves/secp256k1.js"
import { AggregatedError, Transaction } from "micro-eth-signer"
import { ToolError } from "../errors"
import { parseEvmAddress } from "./address"
import { checkUint256 } from "./uint256"

/**
 * An EIP-1559 (type 2) transaction to sign: no access list, and always a
 * recipient, so none creates a contract.
 */
export type EvmTransactionRequest = {
  chainId: number
  to: string
  value: bigint
  /** `0x` and an even number of hex digits. */
  data: string
  nonce: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/** A type 2 transaction of the library, signed or not. */
export type EvmTransaction = InstanceType<typeof Transaction<"eip1559">>

/** The gas of a transaction with no data: no transaction can use less. */
const MIN_GAS_LIMIT = 21_000n

/** `0x` and whole bytes of hex digits. */
const DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/

/** The yParity of the placeholder signature. */
const PLACEHOLDER_Y_PARITY = 1

function invalid(problem: string): ToolError {
  return new ToolError("invalid_argument", `The transaction ${problem}`)
}

/** Refuses a request that cannot be signed, as `invalid_argument`, before any key is read. */
function checkRequest(request: EvmTransactionRequest): void {
  if (!Number.isSafeInteger(request.chainId) || request.chainId < 1) {
    throw invalid("needs a chain id that is a whole number from 1.")
  }
  checkUint256(request.value, "value")
  checkUint256(request.nonce, "nonce")
  checkUint256(request.gasLimit, "gas limit")
  checkUint256(request.maxFeePerGas, "max fee per gas")
  checkUint256(request.maxPriorityFeePerGas, "max priority fee per gas")
  if (typeof request.data !== "string" || !DATA_PATTERN.test(request.data)) {
    throw invalid("needs data that is 0x and whole bytes of hex digits.")
  }
  if (request.gasLimit < MIN_GAS_LIMIT) throw invalid(`needs a gas limit of ${MIN_GAS_LIMIT} at least.`)
  if (request.maxPriorityFeePerGas > request.maxFeePerGas) {
    throw invalid("has a priority fee above its max fee per gas.")
  }
}

/**
 * The unsigned transaction of `request`, checked by `checkRequest`; a request
 * that fails is `invalid_argument`. The library's strict limits (a nonce up to
 * 131072, fees up to 10000 gwei, a value under a million coins) are left off,
 * since chains take more: a fee or value the chain refuses is its refusal. No
 * key is involved.
 */
export function prepareEvmTransaction(request: EvmTransactionRequest): EvmTransaction {
  checkRequest(request)
  const to = parseEvmAddress(request.to)
  try {
    return Transaction.prepare(
      {
        type: "eip1559",
        to,
        value: request.value,
        data: request.data,
        nonce: request.nonce,
        gasLimit: request.gasLimit,
        maxFeePerGas: request.maxFeePerGas,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas,
        chainId: BigInt(request.chainId),
        accessList: [],
      },
      false,
    )
  } catch (error) {
    if (error instanceof AggregatedError) {
      throw invalid(`is not valid: ${error.errors.map((problem) => `${problem.field}: ${problem.error}`).join("; ")}.`)
    }
    throw invalid("could not be built.")
  }
}

/** The unsigned type 2 serialization of `request`, which OP Stack's `getL1Fee` takes. */
export function unsignedEvmTransactionHex(request: EvmTransactionRequest): string {
  return prepareEvmTransaction(request).toHex()
}

/**
 * `request` serialized with a placeholder signature, for Scroll's `getL1Fee`,
 * which takes the signed transaction. `r` and `s` are the largest values (the
 * curve's order less one), so no real signature of the request is longer: the
 * result is an upper bound of its size. No key is read.
 */
export function placeholderSignedEvmTransactionHex(request: EvmTransactionRequest): string {
  const unsigned = prepareEvmTransaction(request)
  const largest = secp256k1.Point.Fn.ORDER - 1n
  return new Transaction(
    unsigned.type,
    { ...unsigned.raw, r: largest, s: largest, yParity: PLACEHOLDER_Y_PARITY },
    { strict: false },
  ).toHex()
}
