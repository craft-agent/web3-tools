import { ToolError } from "../errors"
import {
  checkSendsPerHour,
  sendsPerHour,
  withLedger,
  type Ledger,
  type LedgerChange,
  type LedgerRow,
} from "../ledger/store"
import type { ToolContext } from "../tool"
import type { WriteEnv, WritePlan } from "./types"

/** What the locked part of a write leaves for the rest of the call: its ledger row, and the node's refusal when it refused. */
export type SentTransaction = { row: LedgerRow; refusal?: ToolError }

/** The plan made again under the lock, and the refusals that need the chain as it stands, to run once the plan is the approved one. */
export type Rebuilt<Plan extends WritePlan> = { plan: Plan; check(): Promise<void> }

/** Makes the plan again from the call's arguments, as the chain stands now. */
export type Rebuild<Plan extends WritePlan> = () => Promise<Rebuilt<Plan>>

/** A transaction signed and ready to send: what its ledger row records of it, and how it is broadcast. */
export type SignedWrite = {
  /** The hash or signature the transaction has once sent, known before it is. */
  hash: string
  /** The EVM nonce in digits; `null` where the family has none. */
  nonce: string | null
  /** The last block height at which the network takes the transaction in digits; `null` where the family has none. */
  last_valid_height: string | null
  /**
   * Sends the transaction, whose `row` is already in the ledger, and settles the row with what the network answers.
   * Returns the error to throw when the network did not take the transaction. Must never throw.
   */
  broadcast(ledger: Ledger, row: LedgerRow): Promise<ToolError | undefined>
}

/**
 * What a family brings to the locked path of a write. `Open` is what resolving the sender's open rows leaves for
 * signing (EVM: the nonce of a row to take over).
 */
export type WriteDriver<Plan extends WritePlan, Open = void> = {
  /** The ledger's family of this chain. */
  family: LedgerRow["family"]
  /** The chain's key, as the ledger's rows name it. */
  chain: string
  /**
   * Settles what the network says of the sender's open rows, oldest first, and throws `stale` while it holds one
   * without a result. Anything it returns is handed to `sign`.
   */
  resolveOpenRows(ledger: Ledger, sender: string): Promise<Open>
  /** Whether the plan made again is the one that was approved. */
  isSamePlan(confirmed: Plan, rebuilt: Plan): boolean
  /** Prepares and signs the transaction of `plan`; nothing is sent. */
  sign(plan: Plan, open: Open): Promise<SignedWrite>
}

/** Changes a row, and leaves it as it is when that fails: the next send finds it open and resolves it. */
export async function settleQuietly(ledger: Ledger, id: string, change: LedgerChange): Promise<void> {
  try {
    await ledger.settle(id, change)
  } catch {
    // Nothing after the broadcast may fail the call.
  }
}

/**
 * Signs and broadcasts the write under the ledger's lock, from its first check to the broadcast's answer, so two
 * writes never race. The row is written before the broadcast, and a hash the ledger has seen is never sent again.
 * Everything before the row throws as nothing sent; once the row is written nothing throws, since the transaction
 * may be out. `confirmed` is the plan the person approved: `rebuild` makes the plan again under the lock, and the
 * transaction that is signed must be the same. Its `check` runs once it is, with the refusals that need the chain
 * as it stands.
 */
export async function writeUnderLock<Plan extends WritePlan, Open>(
  confirmed: Plan,
  rebuild: Rebuild<Plan>,
  driver: WriteDriver<Plan, Open>,
  { runtime, stateDir }: WriteEnv,
  ctx: ToolContext,
): Promise<SentTransaction> {
  const result: { sent?: SentTransaction } = {}
  try {
    await withLedger(stateDir, runtime.now, async (ledger) => {
      checkSendsPerHour(ledger, sendsPerHour(ctx), runtime.now())
      const open = await driver.resolveOpenRows(ledger, confirmed.sender.address)
      const { plan, check } = await rebuild()
      if (!driver.isSamePlan(confirmed, plan)) {
        throw new ToolError("stale", "What was approved changed before the send could run. Nothing was sent.")
      }
      await check()
      const signed = await driver.sign(plan, open)
      const row = await ledger.add({
        family: driver.family,
        chain: driver.chain,
        sender: plan.sender.address,
        ...plan.ledger,
        hash: signed.hash,
        nonce: signed.nonce,
        last_valid_height: signed.last_valid_height,
      })
      result.sent = { row }
      result.sent.refusal = await signed.broadcast(ledger, row)
    })
  } catch (error) {
    if (result.sent === undefined) throw error
  }
  if (result.sent === undefined) throw new ToolError("internal_error", "The send left no ledger row.")
  return result.sent
}
