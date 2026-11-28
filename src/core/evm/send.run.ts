import type { ToolContext, ToolSpec } from "../tool"
import { runWrite, type WriteRequest, type WriteResult } from "../write/run"
import type { Sleep } from "../write/wait"
import type { LockedPlan, SendEnv } from "./send.build"
import { evmDriver } from "./send.driver"
import { lookupReceipt } from "./send.lookup"

/**
 * The path every write takes once its plan is built and its refusals are past, on an EVM chain: see `runWrite`. The
 * wait looks for the transaction's receipt.
 */
export function runEvmWrite(
  spec: Pick<ToolSpec, "id" | "class">,
  ctx: ToolContext,
  env: SendEnv,
  sleep: Sleep,
  request: WriteRequest<LockedPlan>,
): Promise<WriteResult> {
  return runWrite(spec, ctx, env, { driver: evmDriver(env), lookup: lookupReceipt(env.client) }, sleep, request)
}
