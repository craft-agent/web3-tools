import { formatAmount } from "../amount"
import { TOKEN_PROGRAMS } from "../chains/solana"
import { ToolError } from "../errors"
import type { LedgerRow } from "../ledger/store"
import type { RpcDeps } from "../rpc/client"
import type { ToolContext } from "../tool"
import { gateLedger, type OpenRowsOf } from "../write/gate"
import { MAX_UNIT_LIMIT, quoteSolanaFees, solanaFeeShortfall, type SolanaFeeQuote } from "./fees"
import { compileLegacyMessage, unsignedTransactionBase64 } from "./message"
import { balanceOf, rentExemptMinimum, simulate, unreadable } from "./reads"
import {
  buildSend,
  lockedPlanOf,
  messageOf,
  sendEnv,
  SIMULATED_BLOCKHASH,
  writableOf,
  type LockedPlan,
  type SendEnv,
  type SendPlan,
} from "./send.build"
import { openRowState } from "./send.lookup"
import type { SolanaSendArgs } from "./send.schema"

/** The bytes of an account that holds no data: a wallet, whose rent-exempt minimum a wallet is kept at. */
export const WALLET_BYTES = 0

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** An amount of the native coin as the refusals say it: its lamports, and the coin. */
export function coin(env: Pick<SendEnv, "chain">, lamports: bigint): string {
  return `${lamports} lamports (${formatAmount(lamports, env.chain.native.decimals)} ${env.chain.native.symbol})`
}

/** Refuses a send while an earlier one of this sender on the cluster, `row`, may still land: `stale`, nothing was sent. */
async function checkOpenRow({ client, chain }: SendEnv, row: LedgerRow): Promise<void> {
  const state = await openRowState(client, chain, row)
  if ("waiting" in state) throw state.waiting
}

/** The quote of the plan's transaction: its simulation (the cluster's reason when it would fail) and the fees now. */
export function quoteSend({ client }: SendEnv, plan: LockedPlan): Promise<SolanaFeeQuote> {
  return quoteSolanaFees(client, (budget) => messageOf(plan, SIMULATED_BLOCKHASH, budget), writableOf(plan))
}

/**
 * The lamports of the token account the send creates for the recipient, read from the simulation of the send itself
 * (the cluster knows the size its token program gives the account): 0 when the send creates none.
 */
export async function createdAccountRent(env: SendEnv, plan: SendPlan): Promise<bigint> {
  if (plan.createdAccount === null) return 0n
  const probe = messageOf(lockedPlanOf(plan), SIMULATED_BLOCKHASH, { unitLimit: MAX_UNIT_LIMIT, unitPrice: 0n })
  const { accounts } = await simulate(env.client, unsignedTransactionBase64(compileLegacyMessage(probe)), [
    plan.createdAccount,
  ])
  const [account] = accounts
  if (!account || !TOKEN_PROGRAMS.includes(account.owner)) {
    throw unreadable(env.client, "simulateTransaction", "a simulation that creates the token account")
  }
  return account.lamports
}

/** Refuses a send that would leave the sender with less than `keep`, naming what it would spend and how to send less. */
function checkRoom(env: SendEnv, plan: SendPlan, held: bigint, keep: bigint, accountRent: bigint): void {
  const { sender, kind, units, maxFee } = plan
  const fee = `a fee of up to ${maxFee} lamports`
  const spent = kind === "sol" ? units : 0n
  if (held - spent - accountRent - maxFee >= keep) return
  const base = `${sender.address} holds ${coin(env, held)} on ${env.chain.name}, and a wallet is never left below the ${coin(env, keep)} that keeps it open (the rent-exempt minimum).`
  if (kind !== "sol") {
    const rent =
      accountRent > 0n ? ` and ${accountRent} lamports of rent for the token account created for the recipient` : ""
    throw refusal(`${base} ${fee}${rent} would leave it below that. Add SOL or give a smaller max_fee.`)
  }
  const most = held - maxFee - keep
  const remedy =
    most > 0n
      ? `Send at most ${coin(env, most)} to keep the account open.`
      : "Not even max_fee alone leaves it enough: add SOL or give a smaller max_fee."
  throw refusal(`${base} Sending ${coin(env, units)} with ${fee} would leave it below that. ${remedy}`)
}

/**
 * Refuses, as `invalid_argument`, a send the wallet cannot afford without being left below the rent-exempt minimum:
 * SOL to an address with no account must fund it above that minimum too. The sender keeps the minimum after the
 * amount of a SOL send, the rent of a token account the send creates (read from its simulation) and `max_fee`.
 */
export async function checkFunds(env: SendEnv, plan: SendPlan): Promise<void> {
  const { sender, kind, units, recipientIsNew } = plan
  const keep = await rentExemptMinimum(env.client, WALLET_BYTES)
  if (kind === "sol" && recipientIsNew && units < keep) {
    throw refusal(
      `The recipient has no account yet, and a new account must hold at least ${coin(env, keep)} to exist; send at least that.`,
    )
  }
  const held = await balanceOf(env.client, sender.address)
  checkRoom(env, plan, held, keep, 0n)
  if (plan.createdAccount !== null) checkRoom(env, plan, held, keep, await createdAccountRent(env, plan))
}

/**
 * The refusals every write shares, in order: `sends_per_hour`, an earlier write that may still land, what
 * `checkWallet` refuses (the tool's own check of what the wallet holds), and a `max_fee` below what the cluster asks
 * now, which the quote of the plan's transaction tells. Nothing is signed or sent.
 */
export async function gateWrite(
  env: SendEnv,
  ctx: ToolContext,
  plan: LockedPlan,
  checkWallet: () => Promise<void>,
): Promise<void> {
  const owner: OpenRowsOf = { family: "solana", chain: env.chain.key, sender: plan.sender.address }
  await gateLedger(env, ctx, owner, (row) => checkOpenRow(env, row))
  await checkWallet()
  const shortfall = solanaFeeShortfall(await quoteSend(env, plan), plan.maxFee)
  if (shortfall) throw shortfall
}

/**
 * Every refusal that needs no answer from the person, before anyone is asked: the arguments, the sender, the
 * recipient, the token and its rules, an earlier send that may still land, `sends_per_hour`, the rent and the
 * balances, the cluster's simulation of the transaction, and a `max_fee` below what the cluster asks now. Nothing is
 * signed or sent.
 */
export async function gateSend(args: SolanaSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<void> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildSend(args, env)
  await gateWrite(env, ctx, lockedPlanOf(plan), () => checkFunds(env, plan))
}
