import { isOpen, sameIdentifier } from "../ledger/rows"
import { checkSendsPerHour, readLedger, sendsPerHour, type LedgerRow } from "../ledger/store"
import type { ToolContext } from "../tool"
import type { WriteEnv } from "./types"

/** Whose open rows stop a write: the sender's, on one chain of one family. */
export type OpenRowsOf = { family: LedgerRow["family"]; chain: string; sender: string }

/**
 * The refusals every write shares, first: `sends_per_hour`, then each open row of the sender on the chain, oldest
 * first, put to `blocks`, which throws when the network still holds that row without a result. Nothing is signed or
 * sent.
 */
export async function gateLedger(
  { runtime, stateDir }: WriteEnv,
  ctx: ToolContext,
  { family, chain, sender }: OpenRowsOf,
  blocks: (row: LedgerRow) => Promise<void>,
): Promise<void> {
  const rows = await readLedger(stateDir)
  checkSendsPerHour({ rows }, sendsPerHour(ctx), runtime.now())
  const open = rows.filter(
    (row) => row.family === family && row.chain === chain && sameIdentifier(family, row.sender, sender) && isOpen(row),
  )
  for (const row of open) await blocks(row)
}
