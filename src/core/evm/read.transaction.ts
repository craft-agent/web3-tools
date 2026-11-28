import { z } from "zod"
import { evmChain, type EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import { OUTCOMES, sameIdentifier } from "../ledger/rows"
import { readLedger, type LedgerRow } from "../ledger/store"
import { evmClient, type RpcDeps } from "../rpc/client"
import { requireRuntime } from "../runtime"
import type { ToolContext } from "../tool"
import { parseQuantity } from "./reads"
import { findReceipt, holdsTransaction, transactionUrl } from "./send.lookup"

/** A transaction hash: `0x` and 64 hex digits. */
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

/** Where a transaction stands on the node: landed and succeeded, landed and reverted, held without a result, or unknown to it. */
export const TRANSACTION_STATUSES = ["confirmed", "failed", "pending", "not_found"] as const

const ledgerPartSchema = z.object({
  row: z.string().describe("The id of the transaction's row in the ledger."),
  outcome: z.enum(OUTCOMES).describe("The row's outcome: unknown, pending, confirmed, failed or rejected."),
  kind: z.string().describe("What the row records: native, erc20, erc721, erc1155, revoke_erc20 or revoke_operator."),
  sender: z.string().describe("The sending wallet's address."),
  recipient: z.string().describe("The recipient's address, or the spender's for a revoke."),
  token: z.string().nullable().describe("The token's or the collection's address; null for the native coin."),
  amount: z
    .string()
    .describe("The amount in the token's smallest unit, as digits; how many for an NFT; 0 for a revoke."),
  nonce: z.string().nullable().describe("The nonce the transaction was signed with."),
  created_at: z.string().describe("When the row was written, as an ISO 8601 time."),
  updated_at: z.string().describe("When the row last changed, as an ISO 8601 time."),
})

/** The `transaction` result of `web3_evm_read`. */
export const transactionSchema = z.object({
  chain: z.string().describe("The chain's key."),
  hash: z.string().describe("The transaction's hash, in lower case."),
  status: z
    .enum(TRANSACTION_STATUSES)
    .describe(
      "confirmed: landed and succeeded; failed: landed but reverted, the fee was spent; pending: the node holds it without a result; not_found: the node knows nothing of it.",
    ),
  block: z.string().nullable().describe("The block it landed in; null unless confirmed or failed."),
  confirmations: z
    .number()
    .int()
    .nullable()
    .describe("The latest block less its block, plus 1; null unless confirmed or failed."),
  explorer: z.string().describe("The transaction's page on the chain's block explorer."),
  ledger: ledgerPartSchema
    .nullable()
    .describe("What this package's ledger holds of it, when a send or revoke of this package made it; else null."),
})

/** What `transaction` takes: the chain's key and the hash, both optional until the method needs them. */
export type TransactionArgs = { chain?: string; hash?: string }

function ledgerPart(row: LedgerRow): z.output<typeof ledgerPartSchema> {
  const { id, outcome, kind, sender, recipient, token, amount, nonce, created_at, updated_at } = row
  return { row: id, outcome, kind, sender, recipient, token, amount, nonce, created_at, updated_at }
}

/** The ledger's row of the transaction, when the call has a ledger and it holds one; a read never writes the ledger. */
async function ledgerOf(
  ctx: ToolContext,
  chain: EvmChain,
  hash: string,
): Promise<z.output<typeof ledgerPartSchema> | null> {
  if (!ctx.runtime || !ctx.stateDir) return null
  const { stateDir } = requireRuntime(ctx, "Reading the ledger")
  const rows = await readLedger(stateDir)
  const row = rows.find(
    (held) => held.family === "evm" && held.chain === chain.key && sameIdentifier("evm", held.hash, hash),
  )
  return row === undefined ? null : ledgerPart(row)
}

/**
 * Where the transaction `hash` stands on `chain`: `confirmed` or `failed` with its block and confirmations once it
 * has a receipt, `pending` while the node holds it without one, `not_found` when it knows nothing. A hash that is
 * not `0x` and 64 hex digits, or a call without `chain` and `hash`, is `invalid_argument`.
 */
export async function readTransaction(
  args: TransactionArgs,
  ctx: ToolContext,
  deps: RpcDeps,
): Promise<z.output<typeof transactionSchema>> {
  if (args.chain === undefined || args.hash === undefined) {
    throw new ToolError("invalid_argument", 'Method "transaction" needs `chain` and `hash`.')
  }
  if (!HASH_PATTERN.test(args.hash)) {
    throw new ToolError("invalid_argument", "The hash must be 0x and 64 hex digits.")
  }
  const chain = evmChain(args.chain)
  const hash = args.hash.toLowerCase()
  const client = evmClient(chain, { ...deps, signal: ctx.signal })
  const ledger = await ledgerOf(ctx, chain, hash)
  const base = { chain: chain.key, hash, explorer: transactionUrl(chain, hash), ledger }
  const receipt = await findReceipt(client, hash)
  if (receipt === null) {
    const status = (await holdsTransaction(client, hash)) ? "pending" : "not_found"
    return { ...base, status, block: null, confirmations: null }
  }
  const head = parseQuantity(client, await client.call("eth_blockNumber"), "eth_blockNumber")
  return {
    ...base,
    status: receipt.status === 1 ? "confirmed" : "failed",
    block: String(receipt.block),
    confirmations: head >= receipt.block ? Number(head - receipt.block) + 1 : 1,
  }
}
