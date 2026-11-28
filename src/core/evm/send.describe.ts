import { formatAmount } from "../amount"
import type { RpcDeps } from "../rpc/client"
import { requireRuntime } from "../runtime"
import { ownAddresses, resolveAccount } from "../signer/accounts"
import type { CallDescription, CallFact, CallHeadline, CallValue, ToolContext } from "../tool"
import { buildSend, parseAddressArgument, sendEnv, SEND_SUBJECT, type SendPlan } from "./send.build"
import type { EvmSendArgs } from "./send.schema"

/** The wallet that owns an address, as the person names it: `main`, or `main#3` for an account of a seed phrase. */
type OwnWallet = { label: string; index: number | null }

/** The headline of a send: what it moves and where. A token with no symbol to show is named by its kind. */
function headlineOf({ chain, units, decimals, symbol }: SendPlan): CallHeadline {
  const amount = formatAmount(units, decimals)
  return symbol === null
    ? { text: "Send {amount} of a token on {chain}", values: { amount, chain: chain.name } }
    : { text: "Send {amount} {symbol} on {chain}", values: { amount, symbol, chain: chain.name } }
}

function ownerFact(own: OwnWallet | undefined): CallFact {
  const value: CallValue = own
    ? { text: "your wallet {wallet}", values: { wallet: own.index === null ? own.label : `${own.label}#${own.index}` } }
    : { text: "not one of your wallets" }
  return { label: "Own wallet", value }
}

function tokenFact({ chain, token, symbol }: SendPlan): CallFact {
  if (token === null) {
    return {
      label: "Token",
      value: { text: "{chain}'s native coin {symbol}", values: { chain: chain.name, symbol: chain.native.symbol } },
    }
  }
  return {
    label: "Token",
    value:
      symbol === null
        ? { text: "{address}, whose declared symbol is not shown", values: { address: token } }
        : { text: '{address} declaring the symbol "{symbol}"', values: { address: token, symbol } },
  }
}

function amountFact({ chain, token, symbol, units, decimals }: SendPlan): CallFact {
  const amount = formatAmount(units, decimals)
  if (token === null) {
    return {
      label: "Amount",
      value: {
        text: "{amount} {symbol} ({units} wei)",
        values: { amount, symbol: chain.native.symbol, units: String(units) },
      },
    }
  }
  const values = { amount, units: String(units), decimals }
  return {
    label: "Amount",
    value:
      symbol === null
        ? { text: "{amount} ({units} smallest units, {decimals} decimals)", values }
        : { text: "{amount} {symbol} ({units} smallest units, {decimals} decimals)", values: { ...values, symbol } },
  }
}

function feeFact({ chain, maxFee }: SendPlan): CallFact {
  return {
    label: "Max fee",
    value: {
      text: "{wei} wei ({amount} {symbol})",
      values: { wei: String(maxFee), amount: formatAmount(maxFee, chain.native.decimals), symbol: chain.native.symbol },
    },
  }
}

/** What a send's prompt names as its targets: the sender and the recipient, so an "always" answer covers that pair only. */
export async function sendTargets(args: EvmSendArgs, ctx: ToolContext): Promise<string[]> {
  const { runtime, stateDir } = requireRuntime(ctx, SEND_SUBJECT)
  const sender = await resolveAccount(args.account, "evm", runtime, stateDir)
  return [`from:${sender.address}`, `to:${parseAddressArgument(args.to, "recipient")}`]
}

/**
 * What the send will do, for the person approving it: the recipient that counts, whether it is one of the person's
 * own wallets, the token, the amount and the fee ceiling. Nothing that moves with the market is in it, so it is the
 * same for the same transaction; the pins hold what is signed.
 */
export async function describeSend(args: EvmSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallDescription> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildSend(args, env)
  const own = (await ownAddresses(env.runtime, env.stateDir)).evm.get(plan.recipient.toLowerCase())
  return {
    headline: headlineOf(plan),
    facts: [
      { label: "Recipient", value: plan.recipient },
      ownerFact(own),
      tokenFact(plan),
      amountFact(plan),
      feeFact(plan),
    ],
    pins: {
      chain: plan.chain.key,
      from: plan.call.from,
      to: plan.call.to,
      value: String(plan.call.value),
      data: plan.call.data,
    },
  }
}
