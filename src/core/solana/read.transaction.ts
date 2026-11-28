import { base58 } from "@scure/base"
import { z } from "zod"
import { solanaChain, type SolanaChain } from "../chains/solana"
import { ToolError } from "../errors"
import { OUTCOMES } from "../ledger/rows"
import { readLedger, type LedgerRow } from "../ledger/store"
import { solanaClient, type RpcDeps } from "../rpc/client"
import { requireRuntime } from "../runtime"
import type { ToolContext } from "../tool"
import { blockHeight, signatureStatus } from "./reads"
import { transactionUrl } from "./send.lookup"

/** A signature is 64 bytes. */
const SIGNATURE_BYTES = 64

/** Where a transaction stands: landed and succeeded, landed with an error, possibly still to land, can never land, or unknown. */
export const TRANSACTION_STATUSES = ["confirmed", "failed", "pending", "expired", "not_found"] as const

const ledgerPartSchema = z.object({
  row: z.string().describe("The id of the transaction's row in the ledger."),
  outcome: z.enum(OUTCOMES).describe("The row's outcome: unknown, pending, confirmed, failed or rejected."),
  kind: z.string().describe("What the row records: sol, spl, nft or revoke."),
  sender: z.string().describe("The sending wallet's address."),
  recipient: z.string().describe("The recipient's address, or the delegate's for a revoke."),
  token: z.string().nullable().describe("The token's mint; null for SOL."),
  amount: z.string().describe("The amount in the token's smallest unit, as digits; 1 for an NFT; 0 for a revoke."),
  last_valid_height: z
    .string()
    .nullable()
    .describe("The last block height at which the cluster takes the transaction's blockhash."),
  created_at: z.string().describe("When the row was written, as an ISO 8601 time."),
  updated_at: z.string().describe("When the row last changed, as an ISO 8601 time."),
})

/** The `transaction` result of `web3_solana_read`. */
export const transactionSchema = z.object({
  chain: z.string().describe("The cluster's key."),
  signature: z.string().describe("The transaction's signature."),
  status: z
    .enum(TRANSACTION_STATUSES)
    .describe(
      "confirmed: landed and succeeded; failed: landed with an error, the fee was spent; pending: processed but not yet confirmed, or unknown to the cluster while its blockhash may still be valid for a send of the ledger; expired: unknown to the cluster and its blockhash has expired, so it can never land; not_found: the cluster knows nothing of it and the ledger has no row to say more.",
    ),
  slot: z.string().nullable().describe("The slot it landed in; null unless the cluster knows it."),
  confirmation_status: z
    .enum(["processed", "confirmed", "finalized"])
    .nullable()
    .describe("How settled the cluster says it is; null unless the cluster knows it."),
  explorer: z.string().describe("The transaction's page on the cluster's block explorer."),
  ledger: ledgerPartSchema
    .nullable()
    .describe("What this package's ledger holds of it, when a send or revoke of this package made it; else null."),
})

/** What `transaction` takes: the cluster's key and the signature, both optional until the method needs them. */
export type TransactionArgs = { chain?: string; signature?: string }

function isSignature(text: string): boolean {
  try {
    return base58.decode(text).length === SIGNATURE_BYTES
  } catch {
    return false
  }
}

function ledgerPart(row: LedgerRow): z.output<typeof ledgerPartSchema> {
  const { id, outcome, kind, sender, recipient, token, amount, last_valid_height, created_at, updated_at } = row
  return { row: id, outcome, kind, sender, recipient, token, amount, last_valid_height, created_at, updated_at }
}

/** The ledger's row of the transaction, when the call has a ledger and it holds one; a read never writes the ledger. */
async function ledgerRowOf(ctx: ToolContext, chain: SolanaChain, signature: string): Promise<LedgerRow | null> {
  if (!ctx.runtime || !ctx.stateDir) return null
  const { stateDir } = requireRuntime(ctx, "Reading the ledger")
  const rows = await readLedger(stateDir)
  return rows.find((row) => row.family === "solana" && row.chain === chain.key && row.hash === signature) ?? null
}

/** Whether the row may still land: it is not settled as landed, and the cluster has not passed its last valid height. */
function mayStillLand(row: LedgerRow, height: bigint): boolean {
  return height <= BigInt(row.last_valid_height ?? 0)
}

/**
 * Where the transaction `signature` stands on `chain`: `confirmed` or `failed` once the cluster has confirmed it,
 * `pending` while it is only processed, or unknown to the cluster while a ledger row says its blockhash is still
 * valid, `expired` when the cluster does not know it and the row's last valid height has passed, `not_found` when
 * nothing says more. A signature that is not base58 of 64 bytes, or a call without `chain` and `signature`, is
 * `invalid_argument`.
 */
export async function readTransaction(
  args: TransactionArgs,
  ctx: ToolContext,
  deps: RpcDeps,
): Promise<z.output<typeof transactionSchema>> {
  if (args.chain === undefined || args.signature === undefined) {
    throw new ToolError("invalid_argument", 'Method "transaction" needs `chain` and `signature`.')
  }
  if (!isSignature(args.signature)) {
    throw new ToolError("invalid_argument", "The signature must be base58 of 64 bytes.")
  }
  const chain = solanaChain(args.chain)
  const { signature } = args
  const client = solanaClient(chain, { ...deps, signal: ctx.signal })
  const row = await ledgerRowOf(ctx, chain, signature)
  const unsettled =
    row !== null && row.last_valid_height !== null && row.outcome !== "confirmed" && row.outcome !== "failed"
  // The height is read before the status, so that a signature the status does not know cannot have landed after it.
  const height = unsettled ? await blockHeight(client) : null
  const status = await signatureStatus(client, signature)
  const base = {
    chain: chain.key,
    signature,
    explorer: transactionUrl(chain, signature),
    ledger: row === null ? null : ledgerPart(row),
  }
  if (status !== null) {
    const { confirmationStatus } = status
    const landed = confirmationStatus === "confirmed" || confirmationStatus === "finalized"
    return {
      ...base,
      status: !landed ? "pending" : status.err === null ? "confirmed" : "failed",
      slot: String(status.slot),
      confirmation_status: confirmationStatus,
    }
  }
  const unknown = { ...base, slot: null, confirmation_status: null }
  if (row === null || height === null) return { ...unknown, status: "not_found" }
  return { ...unknown, status: mayStillLand(row, height) ? "pending" : "expired" }
}
