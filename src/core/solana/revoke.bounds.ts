import type { RpcDeps } from "../rpc/client"
import type { CallMeasure, ToolBounds, ToolContext } from "../tool"
import { ceilToNumber, PATH_SEPARATOR } from "../write/bounds"
import { buildRevoke } from "./revoke.build"
import type { SolanaRevokeArgs } from "./revoke.schema"
import { sendEnv } from "./send.build"

/** What a grant over `web3_solana_revoke` can limit beyond its targets, rate and expiry. */
export const REVOKE_BOUNDS: ToolBounds = {
  asset: {
    kind: "prefix",
    separator: PATH_SEPARATOR,
    description:
      "The clusters and tokens a revoke may use: <chain> for any token on it, or <chain>/<mint address> for one, as written in base58.",
  },
  max_fee: { kind: "max", description: "The highest max_fee a revoke may give, in lamports." },
}

/** This revoke's value for each bound of `REVOKE_BOUNDS`; it asks the cluster whether there is a delegate to revoke. */
export async function measureRevoke(args: SolanaRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallMeasure> {
  const plan = await buildRevoke(args, sendEnv(args.chain, ctx, deps))
  return {
    asset: `${plan.chain.key}${PATH_SEPARATOR}${plan.mint}`,
    max_fee: ceilToNumber(plan.maxFee),
  }
}
