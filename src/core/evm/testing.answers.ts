import type { FakeRpcAnswer } from "../rpc/testing"
import { quantityHex, word } from "./abi"
import { revertData, type CallOutcome } from "./testing.contracts"

/**
 * How one `eth_sendRawTransaction` goes wrong, used once in the order given to `failSend`:
 * `reject` answers a node error and accepts nothing; `transport` answers HTTP 500 or never answers (the client times
 * out), with the transaction already in the mempool (`accepted`) or not; `"drop"` answers the hash of an accepted
 * transaction that the node forgets at once, so it is never mined and no later call finds it.
 */
export type SendFailure =
  { reject: { code: number; message: string } } | { transport: "http500" | "timeout"; accepted: boolean } | "drop"

/** What the fake answers `getL1Fee`, `getOperatorFee` and `tokenRatio` with; `"revert"` makes the function revert. */
export type FakeOracle = {
  l1Fee: bigint | "revert"
  operatorFee: bigint | "revert"
  tokenRatio: bigint | "revert"
}

/** What the fake answers `linea_estimateGas` with. */
export type FakeLineaEstimate = { gasLimit: bigint; baseFeePerGas: bigint; priorityFeePerGas: bigint }

const NODE_ERROR_CODE = -32000
const METHOD_NOT_FOUND_CODE = -32601
const REVERT_ERROR_CODE = 3

/** A promise that never settles, for an answer that never comes. */
export const never = () => new Promise<never>(() => {})

export const methodNotFound: FakeRpcAnswer = { error: { code: METHOD_NOT_FOUND_CODE, message: "Method not found" } }

/** The error geth gives for a transaction it refuses. */
export const nodeError = (message: string): FakeRpcAnswer => ({ error: { code: NODE_ERROR_CODE, message } })

export const quantity = (value: bigint): FakeRpcAnswer => ({ result: quantityHex(value) })

/** The number in the hex quantity `value`; 0 for anything that is not text. */
export const toBigInt = (value: unknown): bigint => (typeof value === "string" && value !== "" ? BigInt(value) : 0n)

/** A reverted call as a node answers it: code 3, the reason in the message and `Error(reason)` as data. */
export function revertAnswer(reason: string): FakeRpcAnswer {
  const message = `execution reverted${reason === "" ? "" : `: ${reason}`}`
  return { error: { code: REVERT_ERROR_CODE, message, data: revertData(reason) } }
}

/** The answer to an `eth_call` whose result is `outcome`. */
export function outcomeAnswer(outcome: CallOutcome): FakeRpcAnswer {
  return "revert" in outcome ? revertAnswer(outcome.revert) : { result: outcome.returns }
}

/** What an oracle function configured as `value` returns. */
export function oracleOutcome(value: bigint | "revert"): CallOutcome {
  return value === "revert" ? { revert: "" } : { returns: `0x${word(value)}` }
}

/** The answer of a `transport` failure: HTTP 500, or none at all. */
export function transportAnswer(kind: "http500" | "timeout"): FakeRpcAnswer | Promise<FakeRpcAnswer> {
  return kind === "timeout" ? never() : { http: { status: 500, body: "Internal Server Error" } }
}
