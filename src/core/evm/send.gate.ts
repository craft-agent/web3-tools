import { formatAmount } from "../amount"
import { HYPERLIQUID_BRIDGE_ADDRESSES } from "../chains/evm"
import { ToolError } from "../errors"
import { isOpen, sameIdentifier } from "../ledger/rows"
import { checkSendsPerHour, readLedger, sendsPerHour, type LedgerRow } from "../ledger/store"
import type { JsonRpcClient, RpcDeps } from "../rpc/client"
import type { ToolContext } from "../tool"
import { quoteFees, feeShortfall } from "./fees"
import { erc20Balance, nativeBalance, simulateTransfer, transactionCount } from "./reads"
import { buildSend, sendEnv, type SendEnv, type SendPlan } from "./send.build"
import { findReceipt, holdsTransaction, stillWaiting } from "./send.lookup"
import type { EvmSendArgs } from "./send.schema"

const ZERO_ADDRESS = `0x${"0".repeat(40)}`

function sameAddress(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toLowerCase() === b.toLowerCase()
}

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Refuses, as `invalid_argument`, a send no one should make whatever the chain says: to the zero address, to oneself, to a lost-funds address, to the token itself. */
export function refuseUnsendable({ chain, sender, recipient, token }: SendPlan): void {
  if (sameAddress(recipient, ZERO_ADDRESS)) {
    throw refusal(
      "The recipient is the zero address, where funds are burned; give the address that should receive them.",
    )
  }
  if (sameAddress(recipient, sender.address)) {
    throw refusal("The recipient is the sending wallet itself; a send to oneself moves nothing.")
  }
  if (HYPERLIQUID_BRIDGE_ADDRESSES.some((bridge) => sameAddress(recipient, bridge.address))) {
    throw refusal(
      `The recipient is Hyperliquid's deprecated deposit bridge, and funds sent there are lost; a deposit to Hyperliquid is not a plain send.`,
    )
  }
  if (token !== null && sameAddress(recipient, token)) {
    throw refusal(`The recipient is the token's own contract on ${chain.name}, which cannot return tokens sent to it.`)
  }
}

function coin({ chain }: SendPlan, wei: bigint): string {
  return `${wei} wei (${formatAmount(wei, chain.native.decimals)} ${chain.native.symbol})`
}

/**
 * Refuses, as `invalid_argument`, a send the wallet cannot pay for: a native send needs the amount and `max_fee`
 * in the native coin; a token send the amount in the token and `max_fee` in the native coin. Where the token is
 * the chain's native coin as an ERC-20, both come out of one balance.
 */
export async function checkFunds({ client }: SendEnv, plan: SendPlan): Promise<void> {
  const { chain, sender, token, units, maxFee } = plan
  const native = await nativeBalance(client, sender.address)
  const sharesNative = token !== null && sameAddress(token, chain.nativeToken)
  if (token !== null && !sharesNative) {
    const held = await erc20Balance(client, token, sender.address)
    if (held < units) {
      throw refusal(
        `${sender.address} holds ${formatAmount(held, plan.decimals)} of the token ${token} (${held} in its smallest unit) on ${chain.name}, less than the ${formatAmount(units, plan.decimals)} to send. Send a smaller amount.`,
      )
    }
  }
  const needed = token === null || sharesNative ? units + maxFee : maxFee
  if (native < needed) {
    throw refusal(
      `${sender.address} holds ${coin(plan, native)} on ${chain.name}, less than the ${coin(plan, needed)} that ${token === null || sharesNative ? "the amount and max_fee" : "max_fee"} can take. Send a smaller amount or give a smaller max_fee.`,
    )
  }
}

/** Refuses a token transfer the chain would revert or answer `false` to. A native send has nothing to simulate. */
export async function simulateSend(client: JsonRpcClient, { call, token }: SendPlan): Promise<void> {
  if (token !== null) await simulateTransfer(client, call)
}

/** Refuses a send while an earlier one of this sender on the chain is held by the node without a result. */
async function checkOpenRows({ chain, client }: SendEnv, rows: readonly LedgerRow[], sender: string): Promise<void> {
  const open = rows.filter(
    (row) =>
      row.family === "evm" && row.chain === chain.key && sameIdentifier("evm", row.sender, sender) && isOpen(row),
  )
  for (const row of open) {
    if ((await findReceipt(client, row.hash)) === null && (await holdsTransaction(client, row.hash))) {
      throw stillWaiting(chain, row.hash)
    }
  }
}

/**
 * Every refusal that needs no answer from the person, before anyone is asked: the arguments, the sender, what
 * `refuseUnsendable` names, an earlier send still held by the node, `sends_per_hour`, the balances, the simulation of
 * a token's transfer, and a `max_fee` below what the network asks now. Nothing is signed or sent.
 */
export async function gateSend(args: EvmSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<void> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildSend(args, env)
  refuseUnsendable(plan)
  const rows = await readLedger(env.stateDir)
  checkSendsPerHour({ rows }, sendsPerHour(ctx), env.runtime.now())
  await checkOpenRows(env, rows, plan.sender.address)
  await checkFunds(env, plan)
  await simulateSend(env.client, plan)
  const pending = await transactionCount(env.client, plan.sender.address, "pending")
  const shortfall = feeShortfall(await quoteFees(env.client, env.chain, plan.call, pending), plan.maxFee)
  if (shortfall) throw shortfall
}
