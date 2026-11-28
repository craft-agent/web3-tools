import type { RpcDeps } from "../rpc/client"
import type { CallMeasure, ToolBounds, ToolContext } from "../tool"
import { buildRevoke } from "./revoke.build"
import type { EvmRevokeArgs } from "./revoke.schema"
import { sendEnv } from "./send.build"
import { ceilToNumber, PATH_SEPARATOR } from "./send.bounds"

/** What a grant over `web3_evm_revoke` can limit beyond its targets, rate and expiry. */
export const REVOKE_BOUNDS: ToolBounds = {
  asset: {
    kind: "prefix",
    separator: PATH_SEPARATOR,
    description:
      "The chains and tokens a revoke may use: <chain> for any token on it, or <chain>/<token or NFT collection address in lower case> for one.",
  },
  max_fee: { kind: "max", description: "The highest max_fee a revoke may give, in wei." },
}

/** This revoke's value for each bound of `REVOKE_BOUNDS`; it asks the chain which approval there is to revoke. */
export async function measureRevoke(args: EvmRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallMeasure> {
  const plan = await buildRevoke(args, sendEnv(args.chain, ctx, deps))
  return {
    asset: `${plan.chain.key}${PATH_SEPARATOR}${plan.token.toLowerCase()}`,
    max_fee: ceilToNumber(plan.maxFee),
  }
}
