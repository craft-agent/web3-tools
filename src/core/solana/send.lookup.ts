import type { SolanaChain } from "../chains/solana"
import { ToolError } from "../errors"
import type { LedgerChange, LedgerRow } from "../ledger/store"
import type { JsonRpcClient } from "../rpc/client"
import type { Landed, Lookup } from "../write/wait"
import { blockHeight, signatureStatus, type SignatureStatus } from "./reads"

const EXPIRED_NOTE = "Its blockhash expired before it landed; it can never land."

/** What a send's open ledger row stands as on the cluster: settled, or still something the cluster may land. */
export type OpenRowState =
  | { settle: LedgerChange }
  | {
      /** The refusal for a send while this row may still land: `stale`, nothing was sent. */
      waiting: ToolError
      /** Whether the cluster knows the signature (it is processed), so that the row is `pending` rather than `unknown`. */
      held: boolean
    }

/** The transaction's page on the cluster's block explorer. */
export function transactionUrl(chain: SolanaChain, signature: string): string {
  const cluster = chain.cluster === "mainnet-beta" ? "" : `?cluster=${chain.cluster}`
  return `${chain.explorer}/tx/${signature}${cluster}`
}

function stillWaiting(chain: SolanaChain, { hash, last_valid_height }: LedgerRow, held: boolean): ToolError {
  const reason = held
    ? "is processed but not yet confirmed, and may still be rolled back"
    : `may still land until block height ${last_valid_height}`
  return new ToolError(
    "stale",
    `The earlier send ${hash} on ${chain.name} ${reason}, so nothing was sent. Wait for it, and check the signature on the explorer: ${transactionUrl(chain, hash)}.`,
  )
}

/** What a signature's status settles a row as: only a transaction the cluster has confirmed is settled, since a processed one may be rolled back. */
function landedOf(status: SignatureStatus): Landed | null {
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") return null
  return { outcome: status.err === null ? "confirmed" : "failed", block: String(status.slot) }
}

/** What a row's transaction landed as, from its signature's status on `client`'s cluster; `null` while it has none. */
export function lookupSignature(client: JsonRpcClient): Lookup {
  return async (row) => {
    const status = await signatureStatus(client, row.hash)
    return status === null ? null : landedOf(status)
  }
}

/**
 * Where an open row stands. The block height is read before the signature's status, so that a transaction the status
 * does not know cannot have landed after the cluster passed the row's last valid height: such a row can never land
 * and is `rejected`. A signature the cluster knows is settled once confirmed; a processed one, and one the cluster
 * does not know while its blockhash is still valid, may still land.
 */
export async function openRowState(client: JsonRpcClient, chain: SolanaChain, row: LedgerRow): Promise<OpenRowState> {
  if (row.last_valid_height === null) {
    throw new ToolError(
      "internal_error",
      `The ledger row ${row.id} has no last valid block height, so it cannot be resolved by hand.`,
    )
  }
  const height = await blockHeight(client)
  const status = await signatureStatus(client, row.hash)
  if (status !== null) {
    const landed = landedOf(status)
    return landed === null ? { waiting: stillWaiting(chain, row, true), held: true } : { settle: landed }
  }
  if (height > BigInt(row.last_valid_height)) return { settle: { outcome: "rejected", note: EXPIRED_NOTE } }
  return { waiting: stillWaiting(chain, row, false), held: false }
}
