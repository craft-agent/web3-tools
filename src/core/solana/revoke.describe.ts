import type { RpcDeps } from "../rpc/client"
import type { CallDescription, CallHeadline, ToolContext } from "../tool"
import { contractValue } from "../write/describe"
import { buildRevoke, type RevokePlan } from "./revoke.build"
import type { SolanaRevokeArgs } from "./revoke.schema"
import { sendEnv } from "./send.build"
import { feeFact, pinsOf } from "./send.describe"

/** The headline of a revoke: whose approval to move which token, on which cluster. */
function headlineOf({ chain, delegate, mint }: RevokePlan): CallHeadline {
  return {
    text: "Revoke {delegate}'s approval to move {mint} on {chain}",
    values: { delegate, mint, chain: chain.name },
  }
}

/**
 * What a revoke's prompt names as its targets: the wallet and the delegate its token account names, so an "always"
 * answer covers that pair only.
 */
export async function revokeTargets(args: SolanaRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<string[]> {
  const { sender, delegate } = await buildRevoke(args, sendEnv(args.chain, ctx, deps))
  return [`from:${sender.address}`, `delegate:${delegate}`]
}

/**
 * What the revoke will do, for the person approving it: the delegate, the token, what is revoked and the fee ceiling.
 * What the delegate may still move is not in it, as it changes with every spend; the pins hold what is signed.
 */
export async function describeRevoke(
  args: SolanaRevokeArgs,
  ctx: ToolContext,
  deps: RpcDeps,
): Promise<CallDescription> {
  const plan = await buildRevoke(args, sendEnv(args.chain, ctx, deps))
  return {
    headline: headlineOf(plan),
    facts: [
      { label: "Delegate", value: plan.delegate },
      { label: "Token", value: contractValue(plan.mint, plan.symbol) },
      { label: "Revokes", value: { text: "the delegate's approval" } },
      feeFact(plan),
    ],
    pins: pinsOf(plan),
  }
}
