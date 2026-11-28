import { settleLedgerRow, type LedgerRow } from "../ledger/store"
import type { WriteEnv, WriteOutcome } from "./types"

/** Waits for a result this many times, this many milliseconds apart: 20 seconds in all. */
export const WAIT_POLLS = 10
export const WAIT_POLL_MS = 2000

/** The sentences of a write tool's description about the wait and the outcomes it reports. */
export const WAIT_DESCRIPTION = [
  `After the broadcast the tool waits up to ${(WAIT_POLLS * WAIT_POLL_MS) / 1000} s for the transaction to land.`,
  "Outcomes: confirmed (landed and succeeded); failed (landed but reverted, the fee was spent and nothing moved); pending (sent or possibly sent, no result yet).",
].join(" ")

/** How a write stands once the wait is over: `block` is set once it landed. */
export type WaitResult = { outcome: WriteOutcome; block: string | null }

/** A write that landed: whether it succeeded, and its block. */
export type Landed = { outcome: "confirmed" | "failed"; block: string }

/** Looks the transaction of `row` up on the chain: what it landed as, or `null` while the chain has no result for it. */
export type Lookup = (row: LedgerRow) => Promise<Landed | null>

/** Pauses for `ms`, ending early with an `AbortError` when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const STILL_PENDING: WaitResult = { outcome: "pending", block: null }

/**
 * Waits for the transaction of `row` to land and settles the row with what `lookup` finds. Nothing here
 * turns the reply into an error, since the transaction is out: a node that cannot be read, a row that cannot be
 * settled and a cancellation all leave the write `pending`, and no result within the wait does too.
 */
export async function waitForLanding(
  row: LedgerRow,
  { runtime, stateDir }: WriteEnv,
  lookup: Lookup,
  sleep: Sleep,
  signal: AbortSignal | undefined,
): Promise<WaitResult> {
  try {
    for (let poll = 0; poll < WAIT_POLLS; poll++) {
      await sleep(WAIT_POLL_MS, signal)
      const landed = await lookup(row)
      if (landed === null) continue
      await settleLedgerRow(stateDir, runtime.now, row.id, landed)
      return landed
    }
  } catch {
    return STILL_PENDING
  }
  return STILL_PENDING
}
