import { ToolError } from "../errors"
import type { Ledger, LedgerRow } from "../ledger/store"
import { RpcRefusal } from "../rpc/client"
import { rawTransactionBase64, signSolanaTransaction, type SignedSolanaTransaction } from "../signer/sign.solana"
import { settleQuietly, type SignedWrite, type WriteDriver } from "../write/pipeline"
import { capSolanaFees, quoteSolanaFees } from "./fees"
import type { SolanaInstruction } from "./instructions"
import { latestBlockhash } from "./reads"
import { messageOf, writableOf, type LockedPlan, type SendEnv } from "./send.build"
import { openRowState } from "./send.lookup"

const REFUSED_NOTE = "The cluster refused it; nothing was sent."
const OTHER_SIGNATURE_NOTE =
  "The cluster answered another signature than the signed transaction's; the signed one is kept."

/** What the cluster says of a transaction it already holds: the words of its `AlreadyProcessed` error. */
const ALREADY_PROCESSED = /already (?:been )?processed/i

/** The error codes of a node's refusal before it took a transaction: a failed preflight simulation, and a signature that does not verify. */
const NOT_TAKEN_CODES: readonly number[] = [-32002, -32003]

/**
 * The words of a refusal that says the node did not take the transaction, as Agave words them (a failed preflight
 * simulation prefixes the error of the transaction), for a provider that passes them on under another code. Any other
 * refusal leaves the row `unknown`: a provider may have passed the transaction on before it failed, and a row marked
 * `rejected` that lands would let the same funds be sent again.
 */
const NOT_TAKEN_WORDS =
  /simulation failed|Blockhash not found|signature verification|Insufficient funds for fee|invalid account data|Account in use/i

/** The most of a node's refusal an error quotes. */
const MAX_NODE_MESSAGE = 200

/** A run of letters and digits too long for an address: it could be the transaction or a signature, which no error carries. */
const LONG_RUN = /[A-Za-z0-9+/=]{64,}/g

/** The signatures a ledger already holds, which a new transaction must not repeat. */
type KnownSignatures = Pick<Ledger, "find">

function isNotTaken({ rpc }: RpcRefusal): boolean {
  return NOT_TAKEN_CODES.includes(rpc.code) || NOT_TAKEN_WORDS.test(rpc.message)
}

function sameInstructions(a: readonly SolanaInstruction[], b: readonly SolanaInstruction[]): boolean {
  return (
    a.length === b.length &&
    a.every((instruction, index) => {
      const other = b[index]!
      return (
        instruction.programId === other.programId &&
        Buffer.from(instruction.data).equals(other.data) &&
        instruction.accounts.length === other.accounts.length &&
        instruction.accounts.every((meta, at) => {
          const peer = other.accounts[at]!
          return meta.address === peer.address && meta.signer === peer.signer && meta.writable === peer.writable
        })
      )
    })
  )
}

/**
 * Settles what the cluster says of this sender's open rows, oldest first: a confirmed signature settles a row as
 * `confirmed` or `failed`; one it holds unconfirmed, or does not know while the row's blockhash is still valid, makes
 * the send `stale`; one it does not know after the blockhash expired can never land and is `rejected`.
 */
async function resolveOpenRows(ledger: Ledger, { chain, client }: SendEnv, sender: string): Promise<KnownSignatures> {
  for (const row of ledger.open("solana", chain.key, sender)) {
    const state = await openRowState(client, chain, row)
    if ("settle" in state) {
      await ledger.settle(row.id, state.settle)
      continue
    }
    if (state.held && row.outcome === "unknown") await ledger.settle(row.id, { outcome: "pending" })
    throw state.waiting
  }
  return ledger
}

function refusedError(row: LedgerRow, message: string): ToolError {
  const reason = message.replace(LONG_RUN, "…").slice(0, MAX_NODE_MESSAGE)
  return new ToolError(
    "upstream_error",
    `The cluster refused the transaction: ${reason === "" ? "it gave no reason" : reason}. Nothing was sent.`,
    { details: { ledger_row: row.id } },
  )
}

/**
 * Sends the signed transaction, whose row is already in the ledger. An answer, or a cluster that already holds it, is
 * `pending`; a refusal that says the node did not take it is `rejected` and returned as the error to throw; anything
 * else (another refusal, a timeout, an HTTP error, a rate limit, a cancellation) leaves the row `unknown`, since the
 * transaction may be out. Never throws.
 */
async function broadcast(
  ledger: Ledger,
  { client }: SendEnv,
  row: LedgerRow,
  signed: SignedSolanaTransaction,
): Promise<ToolError | undefined> {
  let answered: unknown
  try {
    answered = await client.call("sendTransaction", [
      rawTransactionBase64(signed),
      { encoding: "base64", preflightCommitment: "confirmed" },
    ])
  } catch (error) {
    if (!(error instanceof RpcRefusal)) return undefined
    if (ALREADY_PROCESSED.test(error.rpc.message)) {
      await settleQuietly(ledger, row.id, { outcome: "pending" })
      return undefined
    }
    if (!isNotTaken(error)) return undefined
    await settleQuietly(ledger, row.id, { outcome: "rejected", note: REFUSED_NOTE })
    return refusedError(row, error.rpc.message)
  }
  const sameSignature = answered === signed.signature
  await settleQuietly(
    ledger,
    row.id,
    sameSignature ? { outcome: "pending" } : { outcome: "pending", note: OTHER_SIGNATURE_NOTE },
  )
  return undefined
}

/**
 * Takes a fresh blockhash, quotes the fees under the plan's ceiling and signs: a transaction the ledger already holds
 * (the cluster has not moved on from the blockhash of an earlier, refused send) is `stale`, signed but never sent.
 */
async function signWrite(env: SendEnv, plan: LockedPlan, known: KnownSignatures): Promise<SignedWrite> {
  const { client, runtime, stateDir } = env
  const { blockhash, lastValidBlockHeight } = await latestBlockhash(client)
  const quote = await quoteSolanaFees(client, (budget) => messageOf(plan, blockhash, budget), writableOf(plan))
  const budget = capSolanaFees(quote, plan.maxFee)
  const signed = await signSolanaTransaction(plan.sender, messageOf(plan, blockhash, budget), runtime, stateDir)
  if (known.find(signed.signature)) {
    throw new ToolError(
      "stale",
      "The cluster has not moved on from the blockhash of an earlier send of this transaction, which would sign it the same way again. Nothing was sent; try again in a moment.",
    )
  }
  return {
    hash: signed.signature,
    nonce: null,
    last_valid_height: String(lastValidBlockHeight),
    broadcast: (ledger, row) => broadcast(ledger, env, row, signed),
  }
}

/** The locked path of a Solana write on `env`'s cluster: signature statuses, blockhash expiry and the node's refusals. */
export function solanaDriver(env: SendEnv): WriteDriver<LockedPlan, KnownSignatures> {
  return {
    family: "solana",
    chain: env.chain.key,
    resolveOpenRows: (ledger, sender) => resolveOpenRows(ledger, env, sender),
    isSamePlan: (confirmed, rebuilt) =>
      confirmed.sender.address === rebuilt.sender.address &&
      sameInstructions(confirmed.instructions, rebuilt.instructions),
    sign: (plan, known) => signWrite(env, plan, known),
  }
}
