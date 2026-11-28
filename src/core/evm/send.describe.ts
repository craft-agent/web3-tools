import { formatAmount } from "../amount"
import type { RpcDeps } from "../rpc/client"
import { ownAddresses, resolveAccount } from "../signer/accounts"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { buildSend, isNftSend, resolveAddressArgument, sendEnv, type NftSendPlan, type SendPlan } from "./send.build"
import { contractValue, DECLARED_SYMBOL_TEXT, ownerFact, type OwnWallet } from "../write/describe"
import type { EvmSendArgs } from "./send.schema"

/** The headline of a send: what it moves and where. A token with no symbol to show is named by its kind; an NFT by its collection and id. */
function headlineOf(plan: SendPlan): CallHeadline {
  const { chain, units, decimals, symbol } = plan
  const amount = formatAmount(units, decimals)
  if (isNftSend(plan)) {
    const values = { id: String(plan.tokenId), collection: plan.token, chain: chain.name }
    return plan.kind === "erc1155"
      ? { text: "Send {count} of NFT #{id} of {collection} on {chain}", values: { ...values, count: amount } }
      : { text: "Send NFT #{id} of {collection} on {chain}", values }
  }
  return symbol === null
    ? { text: "Send {amount} of a token on {chain}", values: { amount, chain: chain.name } }
    : { text: "Send {amount} {symbol} on {chain}", values: { amount, symbol, chain: chain.name } }
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
        : { text: DECLARED_SYMBOL_TEXT, values: { address: token, symbol } },
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

/** The facts of an NFT send that stand for the token and the amount: the collection, the id and, of an ERC-1155, the count. */
function nftFacts({ token, symbol, tokenId, kind, units }: NftSendPlan): CallFact[] {
  const facts: CallFact[] = [
    { label: "Collection", value: contractValue(token, symbol) },
    { label: "Token id", value: String(tokenId) },
  ]
  return kind === "erc1155" ? [...facts, { label: "Count", value: String(units) }] : facts
}

/** The fact that names the fee ceiling, in wei and in the chain's coin. */
export function feeFact({ chain, maxFee }: Pick<SendPlan, "chain" | "maxFee">): CallFact {
  return {
    label: "Max fee",
    value: {
      text: "{wei} wei ({amount} {symbol})",
      values: { wei: String(maxFee), amount: formatAmount(maxFee, chain.native.decimals), symbol: chain.native.symbol },
    },
  }
}

/** The fact that names the ENS name an address was given as, and the address it resolved to; none for an address. */
export function ensFacts(ens: string | null, address: string): CallFact[] {
  return ens === null
    ? []
    : [{ label: "ENS name", value: { text: "{name} resolved to {address}", values: { name: ens, address } } }]
}

/**
 * What a send's prompt names as its targets: the sender and the recipient (the address an ENS name resolves to),
 * so an "always" answer covers that pair only.
 */
export async function sendTargets(args: EvmSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<string[]> {
  const env = sendEnv(args.chain, ctx, deps)
  const sender = await resolveAccount(args.account, "evm", env.runtime, env.stateDir)
  const { address } = await resolveAddressArgument(args.to, "recipient", env)
  return [`from:${sender.address}`, `to:${address}`]
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
      ...ensFacts(plan.ens, plan.recipient),
      ownerFact(own),
      ...(isNftSend(plan) ? nftFacts(plan) : [tokenFact(plan), amountFact(plan)]),
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
