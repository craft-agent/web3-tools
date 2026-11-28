import type { FakeRpcAnswer } from "../rpc/testing"

/**
 * How one `sendTransaction` goes wrong, used once in the order given to `failSend`: `reject` answers a node error and
 * accepts nothing; `transport` answers HTTP 500 or never answers (the client times out), with the transaction already
 * accepted (`accepted`) or not; `"drop"` answers the signature of an accepted transaction that the node forgets at once,
 * so it never lands.
 */
export type SendFailure =
  { reject: { code: number; message: string } } | { transport: "http500" | "timeout"; accepted: boolean } | "drop"

/** The error codes a node answers with. */
export const NODE_ERROR_CODES = {
  invalidParams: -32602,
  transactionFailed: -32002,
  signatureFailure: -32003,
} as const

/** A promise that never settles, for an answer that never comes. */
export const never = () => new Promise<never>(() => {})

/** The refusal of a transaction that failed the node's preflight, with the `err` it puts in `data`. */
export function preflightError(message: string, err: unknown): FakeRpcAnswer {
  return {
    error: {
      code: NODE_ERROR_CODES.transactionFailed,
      message: `Transaction simulation failed: ${message}`,
      data: { accounts: null, err, logs: [], unitsConsumed: 0 },
    },
  }
}

/** An answer that wraps `value` with the slot it was read at, as most methods do. */
export function inContext(slot: bigint, value: unknown): FakeRpcAnswer {
  return { result: { context: { apiVersion: "fake", slot: Number(slot) }, value } }
}

/** The answer of a `transport` failure: HTTP 500, or none at all. */
export function transportAnswer(kind: "http500" | "timeout"): FakeRpcAnswer | Promise<FakeRpcAnswer> {
  return kind === "timeout" ? never() : { http: { status: 500, body: "Internal Server Error" } }
}
