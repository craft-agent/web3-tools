import type { RpcDeps } from "../rpc/client"
import type { CallMeasure, ToolBounds, ToolContext } from "../tool"
import { ceilToNumber, PATH_SEPARATOR } from "../write/bounds"
import { buildSend, sendEnv } from "./send.build"
import type { EvmSendArgs } from "./send.schema"

/** What a grant over `web3_evm_send` can limit beyond its targets, rate and expiry. */
export const SEND_BOUNDS: ToolBounds = {
  asset: {
    kind: "prefix",
    separator: PATH_SEPARATOR,
    description:
      "The chains and tokens a send may use: <chain> for any asset on it, <chain>/native for its coin, or <chain>/<token or NFT collection address in lower case> for one token or collection.",
  },
  recipient: {
    kind: "prefix",
    separator: PATH_SEPARATOR,
    description: "The recipient addresses, in lower case, a send may go to.",
  },
  amount: {
    kind: "max",
    description: "The most a send may move, in the asset's smallest unit (wei for a native coin); for NFTs, how many.",
  },
  max_fee: { kind: "max", description: "The highest max_fee a send may give, in wei." },
}

/** This send's value for each bound of `SEND_BOUNDS`; it reads the token's decimals, so it asks the chain. */
export async function measureSend(args: EvmSendArgs, ctx: ToolContext, deps: RpcDeps): Promise<CallMeasure> {
  const plan = await buildSend(args, sendEnv(args.chain, ctx, deps))
  const asset = `${plan.chain.key}${PATH_SEPARATOR}${plan.token === null ? "native" : plan.token.toLowerCase()}`
  return {
    asset,
    recipient: plan.recipient.toLowerCase(),
    amount: ceilToNumber(plan.units),
    max_fee: ceilToNumber(plan.maxFee),
  }
}
