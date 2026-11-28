import type { LedgerRow } from "../ledger/store"
import { confirmWrite, type ToolContext, type ToolSpec } from "../tool"
import type { LockedPlan, SendEnv } from "./send.build"
import { sendUnderLock, type Rebuild } from "./send.pipeline"
import { waitForReceipt, type Sleep, type WaitResult } from "./send.wait"

/** What a write asks of the path every write shares: the question for the person, the approved plan, and how to make it again. */
export type WriteRequest = { prompt: string; confirmed: LockedPlan; rebuild: Rebuild }

/** The ledger row of a write that was broadcast, and how it stands once the wait is over. */
export type WriteResult = WaitResult & { row: LedgerRow }

/**
 * The path every write takes once its plan is built and its refusals are past: asks the person where the tool's
 * class needs it, signs and broadcasts under the ledger's lock, throws the node's refusal when it did not take the
 * transaction, then waits for the receipt. Nothing after the row is written throws.
 */
export async function runWrite(
  spec: Pick<ToolSpec, "id" | "class">,
  ctx: ToolContext,
  env: SendEnv,
  sleep: Sleep,
  { prompt, confirmed, rebuild }: WriteRequest,
): Promise<WriteResult> {
  await confirmWrite(spec, ctx, prompt)
  const { row, refusal } = await sendUnderLock(confirmed, rebuild, env, ctx)
  if (refusal) throw refusal
  return { row, ...(await waitForReceipt(row, env, sleep, ctx.signal)) }
}
