import { settleLedgerRow, type LedgerRow } from "../ledger/store"
import type { SendEnv } from "./send.build"
import { findReceipt } from "./send.lookup"
import type { SEND_OUTCOMES } from "./send.schema"

/** Waits for a receipt this many times, this many milliseconds apart: 20 seconds in all. */
export const WAIT_POLLS = 10
export const WAIT_POLL_MS = 2000

/** The sentences of a write tool's description about the wait and the outcomes it reports. */
export const WAIT_DESCRIPTION = [
  `After the broadcast the tool waits up to ${(WAIT_POLLS * WAIT_POLL_MS) / 1000} s for the transaction to land.`,
  "Outcomes: confirmed (landed and succeeded); failed (landed but reverted, the fee was spent and nothing moved); pending (sent or possibly sent, no result yet).",
].join(" ")

/** How a send stands once the wait is over: `block` is set once it landed. */
export type WaitResult = { outcome: (typeof SEND_OUTCOMES)[number]; block: string | null }

/** Pauses for `ms`, ending early with an `AbortError` when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const STILL_PENDING: WaitResult = { outcome: "pending", block: null }

/**
 * Waits for the transaction of `row` to land and settles the row with what the receipt says. Nothing here
 * turns the reply into an error, since the transaction is out: a node that cannot be read, a row that cannot be
 * settled and a cancellation all leave the send `pending`, and no receipt within the wait does too.
 */
export async function waitForReceipt(
  row: LedgerRow,
  { client, runtime, stateDir }: SendEnv,
  sleep: Sleep,
  signal: AbortSignal | undefined,
): Promise<WaitResult> {
  try {
    for (let poll = 0; poll < WAIT_POLLS; poll++) {
      await sleep(WAIT_POLL_MS, signal)
      const receipt = await findReceipt(client, row.hash)
      if (receipt === null) continue
      const block = String(receipt.block)
      const outcome = receipt.status === 1 ? "confirmed" : "failed"
      await settleLedgerRow(stateDir, runtime.now, row.id, { outcome, block })
      return { outcome, block }
    }
  } catch {
    return STILL_PENDING
  }
  return STILL_PENDING
}
