import { ToolError } from "../errors"
import {
  checkSendsPerHour,
  sendsPerHour,
  withLedger,
  type Ledger,
  type LedgerChange,
  type LedgerRow,
} from "../ledger/store"
import { RpcRefusal } from "../rpc/client"
import { rawTransactionHex, signEvmTransaction, type SignedEvmTransaction } from "../signer/sign"
import type { ToolContext } from "../tool"
import { capFees, quoteFees } from "./fees"
import { transactionCount, type EvmCall } from "./reads"
import type { LockedPlan, SendEnv } from "./send.build"
import { findReceipt, holdsTransaction, stillWaiting } from "./send.lookup"

/** What the locked part of a send leaves for the rest of the call: its ledger row, and the node's refusal when it refused. */
export type SentTransaction = { row: LedgerRow; refusal?: ToolError }

/** The plan made again under the lock, and the refusals that need the chain as it stands, to run once the plan is the approved one. */
export type Rebuilt = { plan: LockedPlan; check(): Promise<void> }

/** Makes the plan again from the call's arguments, as the chain stands now. */
export type Rebuild = () => Promise<Rebuilt>

const NONCE_TAKEN_NOTE = "Its nonce was taken by another transaction; it can never land."
const REFUSED_NOTE = "The network refused it; nothing was sent."
const OTHER_HASH_NOTE = "The node answered another hash than the signed transaction's; the signed one is kept."

/** What a node says of a transaction it already holds, in the words of the clients that say it. */
const ALREADY_KNOWN = /already known|known transaction|already imported/i

/**
 * What a node says when it did not take the transaction, in the words of the clients that say it. Any other
 * refusal leaves the row `unknown`: a provider may have passed the transaction on before it failed, and a row
 * marked `rejected` that lands would let the same funds be sent again.
 */
const NOT_TAKEN =
  /nonce too low|nonce too high|insufficient funds|txpool is full|underpriced|intrinsic gas too low|exceeds block gas limit|gas limit reached|fee cap less than block base fee|max fee per gas less than block base fee|invalid sender|invalid chain id|transaction type not supported|tx type not supported|exceeds the configured cap/i

/** The most of a node's refusal an error quotes. */
const MAX_NODE_MESSAGE = 200

/** A run of hex digits too long for a hash or an address: it could be the transaction itself, which no error carries. */
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{66,}/g

/** Changes a row, and leaves it as it is when that fails: the next send finds it open and resolves it. */
async function settleQuietly(ledger: Ledger, id: string, change: LedgerChange): Promise<void> {
  try {
    await ledger.settle(id, change)
  } catch {
    // Nothing after the broadcast may fail the call.
  }
}

function sameCall(a: EvmCall, b: EvmCall): boolean {
  return a.from === b.from && a.to === b.to && a.value === b.value && a.data === b.data
}

/**
 * Settles what the node says of this sender's open rows on the chain, oldest first: a receipt settles a row as
 * `confirmed` or `failed`; a transaction the node holds without a receipt makes the send `stale` (the row becomes
 * `pending`); a hash the node does not know whose nonce another transaction took is `rejected`. Returns the lowest
 * nonce of the rows that remain, which the next transaction takes, so that at most one of the two can ever land.
 */
async function resolveOpenRows(
  ledger: Ledger,
  { chain, client }: SendEnv,
  sender: string,
): Promise<bigint | undefined> {
  let reused: bigint | undefined
  for (const row of ledger.open("evm", chain.key, sender)) {
    const receipt = await findReceipt(client, row.hash)
    if (receipt) {
      await ledger.settle(row.id, {
        outcome: receipt.status === 1 ? "confirmed" : "failed",
        block: String(receipt.block),
      })
      continue
    }
    if (await holdsTransaction(client, row.hash)) {
      if (row.outcome === "unknown") await ledger.settle(row.id, { outcome: "pending" })
      throw stillWaiting(chain, row.hash)
    }
    if (row.nonce === null) {
      throw new ToolError("internal_error", `The ledger row ${row.id} has no nonce, so it cannot be resolved by hand.`)
    }
    const nonce = BigInt(row.nonce)
    if ((await transactionCount(client, sender, "latest")) > nonce) {
      await ledger.settle(row.id, { outcome: "rejected", note: NONCE_TAKEN_NOTE })
    } else if (reused === undefined || nonce < reused) {
      reused = nonce
    }
  }
  return reused
}

function refusedError({ chain }: SendEnv, row: LedgerRow, message: string): ToolError {
  const reason = message.replace(LONG_HEX, "…").slice(0, MAX_NODE_MESSAGE)
  return new ToolError(
    "upstream_error",
    `The network refused the transaction on ${chain.name}: ${reason === "" ? "it gave no reason" : reason}. Nothing was sent.`,
    { details: { ledger_row: row.id } },
  )
}

/**
 * Sends the signed transaction, whose row is already in the ledger. An answer, or a node that already holds it,
 * is `pending`; a node's refusal that says it did not take the transaction is `rejected` and returned as the error
 * to throw; anything else (another refusal, a timeout, an HTTP error, a rate limit, a cancellation) leaves the row
 * `unknown`, since the transaction may be out. Never throws.
 */
async function broadcast(
  ledger: Ledger,
  env: SendEnv,
  row: LedgerRow,
  signed: SignedEvmTransaction,
): Promise<ToolError | undefined> {
  let answered: unknown
  try {
    answered = await env.client.call("eth_sendRawTransaction", [rawTransactionHex(signed)])
  } catch (error) {
    if (!(error instanceof RpcRefusal)) return undefined
    if (ALREADY_KNOWN.test(error.rpc.message)) {
      await settleQuietly(ledger, row.id, { outcome: "pending" })
      return undefined
    }
    if (!NOT_TAKEN.test(error.rpc.message)) return undefined
    await settleQuietly(ledger, row.id, { outcome: "rejected", note: REFUSED_NOTE })
    return refusedError(env, row, error.rpc.message)
  }
  const sameHash = typeof answered === "string" && answered.toLowerCase() === signed.hash.toLowerCase()
  await settleQuietly(ledger, row.id, sameHash ? { outcome: "pending" } : { outcome: "pending", note: OTHER_HASH_NOTE })
  return undefined
}

/**
 * Signs and broadcasts the write under the ledger's lock, from its first check to the broadcast's answer, so two
 * writes never race. The row is written before the broadcast, and a hash the ledger has seen is never sent again:
 * an earlier row the node does not know is taken over by signing a new transaction with its nonce. Everything before
 * the row throws as nothing sent; once the row is written nothing throws, since the transaction may be out.
 * `confirmed` is the plan the person approved: `rebuild` makes the plan again under the lock, and the call that is
 * signed must be the same. Its `check` runs once it is, with the refusals that need the chain as it stands.
 */
export async function sendUnderLock(
  confirmed: LockedPlan,
  rebuild: Rebuild,
  env: SendEnv,
  ctx: ToolContext,
): Promise<SentTransaction> {
  const { chain, client, runtime, stateDir } = env
  const result: { sent?: SentTransaction } = {}
  try {
    await withLedger(stateDir, runtime.now, async (ledger) => {
      checkSendsPerHour(ledger, sendsPerHour(ctx), runtime.now())
      const reusedNonce = await resolveOpenRows(ledger, env, confirmed.sender.address)
      const { plan, check } = await rebuild()
      if (!sameCall(confirmed.call, plan.call)) {
        throw new ToolError("stale", "What was approved changed before the send could run. Nothing was sent.")
      }
      await check()
      const nonce = reusedNonce ?? (await transactionCount(client, plan.sender.address, "pending"))
      const quote = await quoteFees(client, chain, plan.call, nonce)
      const fees = capFees(quote, plan.maxFee)
      const signed = await signEvmTransaction(
        plan.sender,
        {
          chainId: chain.chainId,
          to: plan.call.to,
          value: plan.call.value,
          data: plan.call.data,
          nonce,
          gasLimit: quote.gasLimit,
          ...fees,
        },
        runtime,
        stateDir,
      )
      const row = await ledger.add({
        family: "evm",
        chain: chain.key,
        sender: plan.sender.address,
        ...plan.ledger,
        hash: signed.hash,
        nonce: String(nonce),
        last_valid_height: null,
      })
      result.sent = { row }
      result.sent.refusal = await broadcast(ledger, env, row, signed)
    })
  } catch (error) {
    if (result.sent === undefined) throw error
  }
  if (result.sent === undefined) throw new ToolError("internal_error", "The send left no ledger row.")
  return result.sent
}
