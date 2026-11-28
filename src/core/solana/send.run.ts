import type { ToolContext, ToolSpec } from "../tool"
import { runWrite, type WriteRequest, type WriteResult } from "../write/run"
import type { Sleep } from "../write/wait"
import type { LockedPlan, SendEnv } from "./send.build"
import { solanaDriver } from "./send.driver"
import { lookupSignature } from "./send.lookup"

/**
 * The path every write takes once its plan is built and its refusals are past, on a Solana cluster: see `runWrite`.
 * The wait looks for the transaction's signature status.
 */
export function runSolanaWrite(
  spec: Pick<ToolSpec, "id" | "class">,
  ctx: ToolContext,
  env: SendEnv,
  sleep: Sleep,
  request: WriteRequest<LockedPlan>,
): Promise<WriteResult> {
  return runWrite(spec, ctx, env, { driver: solanaDriver(env), lookup: lookupSignature(env.client) }, sleep, request)
}
