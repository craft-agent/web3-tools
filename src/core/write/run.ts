import type { LedgerRow } from "../ledger/store"
import { confirmWrite, type ToolContext, type ToolSpec } from "../tool"
import { writeUnderLock, type Rebuild, type WriteDriver } from "./pipeline"
import type { WriteEnv, WritePlan } from "./types"
import { waitForLanding, type Lookup, type Sleep, type WaitResult } from "./wait"

/** What a write asks of the path every write shares: the question for the person, the approved plan, and how to make it again. */
export type WriteRequest<Plan extends WritePlan> = { prompt: string; confirmed: Plan; rebuild: Rebuild<Plan> }

/** The ledger row of a write that was broadcast, and how it stands once the wait is over. */
export type WriteResult = WaitResult & { row: LedgerRow }

/** What a family brings to `runWrite`: how it signs and sends under the lock, and how it finds what a transaction landed as. */
export type WriteFamily<Plan extends WritePlan, Open = void> = {
  driver: WriteDriver<Plan, Open>
  lookup: Lookup
}

/**
 * The path every write takes once its plan is built and its refusals are past: asks the person where the tool's
 * class needs it, signs and broadcasts under the ledger's lock, throws the node's refusal when it did not take the
 * transaction, then waits for the transaction to land. Nothing after the row is written throws.
 */
export async function runWrite<Plan extends WritePlan, Open>(
  spec: Pick<ToolSpec, "id" | "class">,
  ctx: ToolContext,
  env: WriteEnv,
  { driver, lookup }: WriteFamily<Plan, Open>,
  sleep: Sleep,
  { prompt, confirmed, rebuild }: WriteRequest<Plan>,
): Promise<WriteResult> {
  await confirmWrite(spec, ctx, prompt)
  const { row, refusal } = await writeUnderLock(confirmed, rebuild, driver, env, ctx)
  if (refusal) throw refusal
  return { row, ...(await waitForLanding(row, env, lookup, sleep, ctx.signal)) }
}
