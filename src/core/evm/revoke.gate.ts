import { ToolError } from "../errors"
import type { RpcDeps } from "../rpc/client"
import type { ToolContext } from "../tool"
import { buildRevoke, lockedRevoke, type RevokePlan } from "./revoke.build"
import type { EvmRevokeArgs } from "./revoke.schema"
import { sendEnv, type SendEnv } from "./send.build"
import { checkNativeBalance, FEE_ONLY_FUNDS, gateWrite, isZeroAddress } from "./send.gate"

/** Refuses, as `invalid_argument`, a revoke of the zero address: no one holds an approval there. */
export function refuseRevoke({ spender }: RevokePlan): void {
  if (isZeroAddress(spender)) {
    throw new ToolError("invalid_argument", "The spender is the zero address, which holds no approval to revoke.")
  }
}

/** Refuses, as `invalid_argument`, a wallet whose native balance cannot cover `max_fee`. */
export function checkRevokeFunds(env: SendEnv, { sender, maxFee }: RevokePlan): Promise<void> {
  return checkNativeBalance(env, sender.address, maxFee, FEE_ONLY_FUNDS)
}

/**
 * Every refusal that needs no answer from the person, before anyone is asked: the arguments, the sender, an
 * approval that is not there, the zero address, an earlier write still held by the node, `sends_per_hour`, the
 * balance for `max_fee`, and a `max_fee` below what the network asks now. Nothing is signed or sent.
 */
export async function gateRevoke(args: EvmRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<void> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildRevoke(args, env)
  refuseRevoke(plan)
  await gateWrite(env, ctx, lockedRevoke(plan), () => checkRevokeFunds(env, plan))
}
