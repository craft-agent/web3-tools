import { ToolError } from "../errors"
import type { RpcDeps } from "../rpc/client"
import type { ToolContext } from "../tool"
import { balanceOf, rentExemptMinimum } from "./reads"
import { buildRevoke, lockedRevoke, type RevokePlan } from "./revoke.build"
import type { SolanaRevokeArgs } from "./revoke.schema"
import { sendEnv, type SendEnv } from "./send.build"
import { coin, gateWrite, WALLET_BYTES } from "./send.gate"

/** Refuses, as `invalid_argument`, a revoke that would leave the sender below the rent-exempt minimum once `max_fee` is spent. */
export async function checkRevokeFunds(env: SendEnv, { sender, maxFee }: RevokePlan): Promise<void> {
  const keep = await rentExemptMinimum(env.client, WALLET_BYTES)
  const held = await balanceOf(env.client, sender.address)
  if (held - maxFee >= keep) return
  throw new ToolError(
    "invalid_argument",
    `${sender.address} holds ${coin(env, held)} on ${env.chain.name}, and a wallet is never left below the ${coin(env, keep)} that keeps it open (the rent-exempt minimum). A fee of up to ${maxFee} lamports would leave it below that. Add SOL or give a smaller max_fee.`,
  )
}

/**
 * Every refusal that needs no answer from the person, before anyone is asked: the arguments, the sender, a token
 * account or a delegate that is not there, an earlier write that may still land, `sends_per_hour`, the balance for
 * `max_fee`, the cluster's simulation of the transaction (a frozen token account fails it) and a `max_fee` below what
 * the cluster asks now. Nothing is signed or sent.
 */
export async function gateRevoke(args: SolanaRevokeArgs, ctx: ToolContext, deps: RpcDeps): Promise<void> {
  const env = sendEnv(args.chain, ctx, deps)
  const plan = await buildRevoke(args, env)
  await gateWrite(env, ctx, lockedRevoke(plan), () => checkRevokeFunds(env, plan))
}
