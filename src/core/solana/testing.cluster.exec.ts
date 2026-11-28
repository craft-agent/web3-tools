import { SOLANA_PROGRAMS } from "../chains/solana"
import { LAMPORTS_PER_SIGNATURE, MAX_UNIT_LIMIT, priorityFee } from "./fees"
import type { SolanaInstruction } from "./instructions"
import { InstructionFailure, runInstruction, type ExecContext } from "./testing.cluster.programs"
import { rentMinimum, type FakeAccounts } from "./testing.cluster.state"
import type { FakeSolanaTx } from "./testing.cluster.tx"

/** What the fake needs besides the transaction to run it. */
export type RunOptions = {
  lamportsPerByte: bigint
  /** Makes the transaction fail on the cluster after it is charged, as `revertWhen` does. */
  forceFail: boolean
}

/** How a transaction ended. */
export type RunResult = {
  /** Whether the cluster would put it in a block: one it cannot charge is not. */
  landed: boolean
  /** The transaction's error as the cluster shows it; `null` when it succeeded. */
  err: unknown
  logs: string[]
  unitsConsumed: number
  /** The lamports charged for it: the signatures' and the priority fee on the limit. */
  fee: bigint
  /** The accounts after it: the fee alone when it failed, all its effects when it succeeded. */
  accounts: FakeAccounts
}

/** The compute units a transaction gets for each instruction that is not the compute budget's when it sets no limit. */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000

const BUDGET_OPCODES = { setComputeUnitLimit: 2, setComputeUnitPrice: 3 } as const

const BUDGET_LIMIT_DATA_BYTES = 5
const BUDGET_PRICE_DATA_BYTES = 9

/** The error of a transaction `revertWhen` fails: its first instruction raises a custom error. */
const FORCED_FAILURE = { InstructionError: [0, { Custom: 0 }] }

/** How the runtime words an instruction's failure after `Program <id> failed: `. */
const FAILURE_WORDS: Readonly<Record<string, string>> = {
  InvalidArgument: "invalid program argument",
  InvalidInstructionData: "invalid instruction data",
  InvalidAccountData: "invalid account data for instruction",
  IncorrectProgramId: "incorrect program id for instruction",
  MissingRequiredSignature: "missing required signature for instruction",
  NotEnoughAccountKeys: "insufficient account keys for instruction",
  InvalidSeeds: "Provided seeds do not result in a valid address",
  IllegalOwner: "Provided owner is not allowed",
  ComputationalBudgetExceeded: "exceeded CUs meter at BPF instruction",
  UnsupportedProgramId: "unsupported program id",
}

function dataView(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

/** The limit and price the transaction's compute budget instructions set, or what it gets when it sets none. */
function budgetOf(instructions: readonly SolanaInstruction[]): { limit: number; price: bigint } {
  const isBudget = (ix: SolanaInstruction) => ix.programId === SOLANA_PROGRAMS.computeBudgetProgram
  let limit = Math.min(
    DEFAULT_UNITS_PER_INSTRUCTION * instructions.filter((ix) => !isBudget(ix)).length,
    MAX_UNIT_LIMIT,
  )
  let price = 0n
  for (const ix of instructions.filter(isBudget)) {
    if (ix.data[0] === BUDGET_OPCODES.setComputeUnitLimit && ix.data.length === BUDGET_LIMIT_DATA_BYTES) {
      limit = Math.min(dataView(ix.data).getUint32(1, true), MAX_UNIT_LIMIT)
    }
    if (ix.data[0] === BUDGET_OPCODES.setComputeUnitPrice && ix.data.length === BUDGET_PRICE_DATA_BYTES) {
      price = dataView(ix.data).getBigUint64(1, true)
    }
  }
  return { limit, price }
}

function wordsOf(reason: unknown): string {
  if (typeof reason === "string") return FAILURE_WORDS[reason] ?? reason
  const custom = (reason as { Custom?: number }).Custom
  return `custom program error: 0x${(custom ?? 0).toString(16)}`
}

/** A transaction the cluster does not put in a block, since its fee payer is missing or cannot pay its fee. */
function notLanded(accounts: FakeAccounts, err: string): RunResult {
  return { landed: false, err, logs: [], unitsConsumed: 0, fee: 0n, accounts }
}

/** The transaction-level error for an account the instructions left below the rent-exempt minimum, or `null` when none is. */
function rentFailure(before: FakeAccounts, after: FakeAccounts, keys: readonly string[], rate: bigint): unknown {
  for (const [address, post] of after) {
    const pre = before.get(address)
    if (pre?.lamports === post.lamports && pre.space === post.space) continue
    if (post.lamports === 0n || post.lamports >= rentMinimum(post.space, rate)) continue
    const wasRentPaying = pre !== undefined && pre.space === post.space && pre.lamports < rentMinimum(pre.space, rate)
    if (!(wasRentPaying && post.lamports <= pre.lamports)) {
      return { InsufficientFundsForRent: { account_index: keys.indexOf(address) } }
    }
  }
  return null
}

/** Drops the accounts that hold nothing, as the cluster does. */
function purgeEmpty(accounts: FakeAccounts): FakeAccounts {
  for (const [address, entry] of accounts) if (entry.lamports === 0n) accounts.delete(address)
  return accounts
}

/**
 * Runs `tx` against `before`, which it does not change. The fee payer is charged `5000` a signature and `ceil(price ×
 * limit / 1e6)` first, whatever happens next; the instructions then run in order on a copy, and their effects are kept
 * only if every one succeeds and no account is left rent-paying where it was not (a new account below the minimum, or
 * an account left between 0 and it). A payer who cannot pay does not land.
 */
export function runTransaction(before: FakeAccounts, tx: FakeSolanaTx, options: RunOptions): RunResult {
  const { instructions } = tx.message
  const { limit, price } = budgetOf(instructions)
  const fee = LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures.length) + priorityFee(price, limit)
  const payer = before.get(tx.keys[0])
  if (payer === undefined) return notLanded(before, "AccountNotFound")
  if (payer.lamports < fee) return notLanded(before, "InsufficientFundsForFee")
  const charged = structuredClone(before)
  const chargedPayer = charged.get(tx.keys[0])
  if (chargedPayer !== undefined) chargedPayer.lamports -= fee

  const working = structuredClone(charged)
  const logs: string[] = []
  let unitsConsumed = 0
  const ctx: ExecContext = {
    accounts: working,
    lamportsPerByte: options.lamportsPerByte,
    spend(units) {
      if (unitsConsumed + units > limit) {
        unitsConsumed = limit
        throw new InstructionFailure("ComputationalBudgetExceeded")
      }
      unitsConsumed += units
    },
  }
  const failed = (err: unknown): RunResult => ({
    landed: true,
    err,
    logs,
    unitsConsumed,
    fee,
    accounts: purgeEmpty(charged),
  })
  for (const [index, ix] of instructions.entries()) {
    const startUnits = unitsConsumed
    logs.push(`Program ${ix.programId} invoke [1]`)
    try {
      runInstruction(ctx, ix)
    } catch (error) {
      if (!(error instanceof InstructionFailure)) throw error
      if (error.programLog !== undefined) logs.push(`Program log: ${error.programLog}`)
      logs.push(`Program ${ix.programId} failed: ${wordsOf(error.reason)}`)
      return failed({ InstructionError: [index, error.reason] })
    }
    logs.push(`Program ${ix.programId} consumed ${unitsConsumed - startUnits} of ${limit} compute units`)
    logs.push(`Program ${ix.programId} success`)
  }
  if (options.forceFail) return failed(FORCED_FAILURE)
  const rent = rentFailure(before, working, tx.keys, options.lamportsPerByte)
  if (rent !== null) return failed(rent)
  return { landed: true, err: null, logs, unitsConsumed, fee, accounts: purgeEmpty(working) }
}
