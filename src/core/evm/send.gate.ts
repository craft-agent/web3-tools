import { formatAmount } from "../amount"
import { HYPERLIQUID_BRIDGE_ADDRESSES, type EvmChain } from "../chains/evm"
import { ToolError } from "../errors"
import { isOpen, sameIdentifier } from "../ledger/rows"
import { checkSendsPerHour, readLedger, sendsPerHour, type LedgerRow } from "../ledger/store"
import type { JsonRpcClient, RpcDeps } from "../rpc/client"
import type { ToolContext } from "../tool"
import { quoteFees, feeShortfall } from "./fees"
import { erc20Balance, nativeBalance, simulateTransfer, transactionCount } from "./reads"
import {
  buildSend,
  isNftSend,
  lockedPlanOf,
  sendEnv,
  type LockedPlan,
  type NftSendPlan,
  type SendEnv,
  type SendPlan,
} from "./send.build"
import { findReceipt, holdsTransaction, stillWaiting } from "./send.lookup"
import { checkNftHeld, type NftHolding } from "./send.nft"
import type { EvmSendArgs } from "./send.schema"

const ZERO_ADDRESS = `0x${"0".repeat(40)}`

function sameAddress(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toLowerCase() === b.toLowerCase()
}

function refusal(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Whether `address` is the zero address. */
export function isZeroAddress(address: string): boolean {
  return sameAddress(address, ZERO_ADDRESS)
}

/** Refuses, as `invalid_argument`, a send no one should make whatever the chain says: to the zero address, to oneself, to a lost-funds address, to the token itself, an ERC-721 in a count other than 1. */
export function refuseUnsendable({ chain, sender, recipient, token, kind, units }: SendPlan): void {
  if (isZeroAddress(recipient)) {
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
    throw refusal(
      kind === "erc20"
        ? `The recipient is the token's own contract on ${chain.name}, which cannot return tokens sent to it.`
        : `The recipient is the collection's own contract on ${chain.name}, which cannot return NFTs sent to it.`,
    )
  }
  if (kind === "erc721" && units !== 1n) {
    throw refusal("An ERC-721 token is one of a kind: the amount must be 1.")
  }
}

function coin(chain: EvmChain, wei: bigint): string {
  return `${wei} wei (${formatAmount(wei, chain.native.decimals)} ${chain.native.symbol})`
}

/** The wording of a funds check where only `max_fee` is spent in the native coin. */
export const FEE_ONLY_FUNDS = { takes: "max_fee", remedy: "Give a smaller max_fee." }

/** Refuses, as `invalid_argument`, a sender whose native balance is below `needed`, which `takes` names and `remedy` says how to lower. */
export async function checkNativeBalance(
  { chain, client }: SendEnv,
  sender: string,
  needed: bigint,
  { takes, remedy }: { takes: string; remedy: string },
): Promise<void> {
  const native = await nativeBalance(client, sender)
  if (native < needed) {
    throw refusal(
      `${sender} holds ${coin(chain, native)} on ${chain.name}, less than the ${coin(chain, needed)} that ${takes} can take. ${remedy}`,
    )
  }
}

function holdingOf({ chain, sender, kind, token, tokenId, units }: NftSendPlan): NftHolding {
  return { kind, collection: token, owner: sender.address, tokenId, count: units, chainName: chain.name }
}

/**
 * Refuses, as `invalid_argument`, a send the wallet cannot pay for: a native send needs the amount and `max_fee`
 * in the native coin; a token send the amount in the token and `max_fee` in the native coin. Where the token is
 * the chain's native coin as an ERC-20, both come out of one balance. An NFT send needs the NFT, or the count of
 * an ERC-1155 token, and `max_fee` in the native coin.
 */
export async function checkFunds(env: SendEnv, plan: SendPlan): Promise<void> {
  const { client } = env
  const { chain, sender, token, kind, units, maxFee } = plan
  if (isNftSend(plan)) {
    await checkNftHeld(client, holdingOf(plan))
    return checkNativeBalance(env, sender.address, maxFee, FEE_ONLY_FUNDS)
  }
  const sharesNative = kind === "erc20" && token !== null && sameAddress(token, chain.nativeToken)
  if (kind === "erc20" && token !== null && !sharesNative) {
    const held = await erc20Balance(client, token, sender.address)
    if (held < units) {
      throw refusal(
        `${sender.address} holds ${formatAmount(held, plan.decimals)} of the token ${token} (${held} in its smallest unit) on ${chain.name}, less than the ${formatAmount(units, plan.decimals)} to send. Send a smaller amount.`,
      )
    }
  }
  const spendsAmount = kind === "native" || sharesNative
  await checkNativeBalance(env, sender.address, spendsAmount ? units + maxFee : maxFee, {
    takes: spendsAmount ? "the amount and max_fee" : "max_fee",
    remedy: "Send a smaller amount or give a smaller max_fee.",
  })
}

/** Refuses a token transfer the chain would revert or answer `false` to. A native send and an NFT send have nothing to simulate: their fee estimate runs the call. */
export async function simulateSend(client: JsonRpcClient, { call, kind }: SendPlan): Promise<void> {
  if (kind === "erc20") await simulateTransfer(client, call)
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
 * The refusals every write shares, in order: `sends_per_hour`, an earlier write still held by the node, what
 * `checkWallet` refuses (the tool's own check of what the wallet holds), and a `max_fee` below what the network
 * asks now, which the quote of the plan's call tells. Nothing is signed or sent.
 */
export async function gateWrite(
  env: SendEnv,
  ctx: ToolContext,
  plan: LockedPlan,
  checkWallet: () => Promise<void>,
): Promise<void> {
  const rows = await readLedger(env.stateDir)
  checkSendsPerHour({ rows }, sendsPerHour(ctx), env.runtime.now())
  await checkOpenRows(env, rows, plan.sender.address)
  await checkWallet()
  const pending = await transactionCount(env.client, plan.sender.address, "pending")
  const shortfall = feeShortfall(await quoteFees(env.client, env.chain, plan.call, pending), plan.maxFee)
  if (shortfall) throw shortfall
}

/**
 * Every refusal that needs no answer from the person, before anyone is asked: the arguments, the sender, what
 * `refuseUnsendable` names, an earlier send still held by the node, `sends_per_hour`, the balances and the NFT's
 * owner, the simulation of a token's transfer, and a `max_fee` below what the network asks now (the estimate of an
 * NFT's transfer runs it, so a recipient that cannot take it is refused with the chain's reason). Nothing is
 * signed or sent.
 */
export async function gateSend(args: EvmSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<void> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildSend(args, env)
  refuseUnsendable(plan)
  await gateWrite(env, ctx, lockedPlanOf(plan), async () => {
    await checkFunds(env, plan)
    await simulateSend(env.client, plan)
  })
}
