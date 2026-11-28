import type { RpcDeps } from "../rpc/client"
import { resolveAccount } from "../signer/accounts"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { buildRevoke, type RevokePlan } from "./revoke.build"
import type { EvmRevokeArgs } from "./revoke.schema"
import { resolveAddressArgument, sendEnv } from "./send.build"
import { contractValue, ensFacts, feeFact } from "./send.describe"

/** The headline of a revoke: whose approval of what, on which chain; an operator's is named by its reach. */
function headlineOf({ chain, kind, spender, token }: RevokePlan): CallHeadline {
  const values = { spender, chain: chain.name }
  return kind === "revoke_erc20"
    ? { text: "Revoke {spender}'s allowance of {token} on {chain}", values: { ...values, token } }
    : {
        text: "Revoke {spender} as operator of every NFT of {collection} on {chain}",
        values: { ...values, collection: token },
      }
}

function tokenFact({ kind, token, symbol }: RevokePlan): CallFact {
  return { label: kind === "revoke_erc20" ? "Token" : "Collection", value: contractValue(token, symbol) }
}

/** What is revoked, in the tool's words: not the allowance's amount, which moves with every spend. */
function revokedFact({ kind }: RevokePlan): CallFact {
  const text = kind === "revoke_erc20" ? "the allowance" : "the operator approval"
  return { label: "Revokes", value: { text } }
}

/**
 * What a revoke's prompt names as its targets: the wallet and the spender (the address an ENS name resolves to),
 * so an "always" answer covers that pair only.
 */
export async function revokeTargets(args: EvmRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<string[]> {
  const env = sendEnv(args.chain, ctx, deps)
  const sender = await resolveAccount(args.account, "evm", env.runtime, env.stateDir)
  const { address } = await resolveAddressArgument(args.spender, "spender", env)
  return [`from:${sender.address}`, `spender:${address}`]
}

/**
 * What the revoke will do, for the person approving it: the spender, the token or collection, what is revoked and
 * the fee ceiling. Nothing that moves with the market is in it; the pins hold what is signed.
 */
export async function describeRevoke(args: EvmRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallDescription> {
  const plan = await buildRevoke(args, sendEnv(args.chain, ctx, deps))
  return {
    headline: headlineOf(plan),
    facts: [
      { label: "Spender", value: plan.spender },
      ...ensFacts(plan.ens, plan.spender),
      tokenFact(plan),
      revokedFact(plan),
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
