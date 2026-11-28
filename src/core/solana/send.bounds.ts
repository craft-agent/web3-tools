import type { RpcDeps } from "../rpc/client"
import type { CallMeasure, ToolBounds, ToolContext } from "../tool"
import { ceilToNumber, PATH_SEPARATOR } from "../write/bounds"
import { buildSend, sendEnv } from "./send.build"
import type { SolanaSendArgs } from "./send.schema"

/** What a grant over `web3_solana_send` can limit beyond its targets, rate and expiry. */
export const SEND_BOUNDS: ToolBounds = {
  asset: {
    kind: "prefix",
    separator: PATH_SEPARATOR,
    description:
      "The clusters and tokens a send may use: <chain> for any asset on it, <chain>/native for SOL, or <chain>/<mint address> for one token or NFT, as written in base58.",
  },
  recipient: {
    kind: "prefix",
    separator: PATH_SEPARATOR,
    description: "The recipient wallet addresses, as written in base58, a send may go to.",
  },
  amount: {
    kind: "max",
    description: "The most a send may move, in the asset's smallest unit (lamports for SOL, 1 for an NFT).",
  },
  max_fee: { kind: "max", description: "The highest max_fee a send may give, in lamports." },
}

/** This send's value for each bound of `SEND_BOUNDS`; it reads the token's decimals, so it asks the cluster. */
export async function measureSend(args: SolanaSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallMeasure> {
  const plan = await buildSend(args, sendEnv(args.chain, ctx, deps))
  return {
    asset: `${plan.chain.key}${PATH_SEPARATOR}${plan.mint ?? "native"}`,
    recipient: plan.recipient,
    amount: ceilToNumber(plan.units),
    max_fee: ceilToNumber(plan.maxFee),
  }
}
