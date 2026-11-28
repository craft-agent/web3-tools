import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import type { z } from "zod"
import { approvalOf, checkPin, type Approval } from "../../entry/pin"
import type { ErrorCode, ToolError } from "../errors"
import { readLedger } from "../ledger/store"
import type { FetchLike } from "../rpc/client"
import type { ToolRuntime } from "../runtime"
import { ABANDON_PHRASE, fakeRuntime, HARDHAT_KEY_0, makeStateDir } from "../signer/testing"
import { invoke, type ToolContext, type ToolSpec } from "../tool"
import { WAIT_POLL_MS, type Sleep } from "./wait"

/** The clock of the fixtures, in epoch milliseconds. */
export const NOW = Date.parse("2026-06-01T12:00:00.000Z")

/** How long a hanging request is left to hang before the fixture's fetch gives up on it, in milliseconds. */
const HANG_LIMIT_MS = 25

/** What a rig needs of a fake chain: the fetch that answers for its node, and a way to land what it holds. */
export type RigFake = { readonly fetch: FetchLike; mine(): unknown }

/** What a test sees of a request before the fake does: its method and parameters. */
export type RequestHook = (method: string, params: unknown[]) => void | Promise<void>

/** What a rig gives the tool it builds: its node, an empty environment, and a wait that mines instead of waiting. */
export type RigDeps = { fetch: FetchLike; env: Record<string, never>; sleep: Sleep }

/** What a rig is set up with: the wallets, and the call's settings. */
export type WalletRigOptions = {
  /** Replaces the wallets: label to key, as `WEB3_TOOLS_WALLET_<LABEL>` holds them. */
  wallets?: Record<string, string>
  options?: ToolContext["options"]
}

/** A write tool wired to a fake chain, a fresh state directory, a clock and a wait that mines instead of waiting. */
export type ToolRig<Spec extends ToolSpec, Fake> = {
  fake: Fake
  stateDir: string
  runtime: ToolRuntime
  /** The call's context; a test may replace it between calls. */
  ctx: ToolContext
  tool: Spec
  /** The pauses the wait asked for, in order. */
  sleeps: number[]
  /** The fake chain mines a block once the wait has paused this long in all (the first poll's pause by default); never, when `undefined`. */
  mineAtMs: number | undefined
  /** Runs before every request reaches the fake, so a test can change the chain at an exact step of a call. */
  beforeRequest: RequestHook | undefined
  /** Gives the next calls a cancellation signal, and returns the controller that aborts it. */
  cancel(): AbortController
  approve(args: unknown): Promise<Approval>
  /** The whole approval flow of a native entry point: gate and approval, the pin check, then the run. */
  run(args: unknown): Promise<z.output<Spec["output"]>>
  /** Runs the call without the approval flow, as an MCP client's call is. */
  invoke(args: unknown): Promise<z.output<Spec["output"]>>
  rows(): ReturnType<typeof readLedger>
  /** The signed transactions the fake received, in order. */
  broadcasts(): string[]
}

const stateDirs: string[] = []

/** Removes the state directories the rigs made. */
export function cleanRigs(): void {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A fetch that gives up on a request the fake never answers, so a lost reply takes milliseconds, and lets a test act first. */
function impatient(fake: RigFake, hook: () => RequestHook | undefined): FetchLike {
  return async (url, init) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] }
    await hook()?.(method, params)
    return fake.fetch(url, {
      ...init,
      signal: AbortSignal.any([init.signal as AbortSignal, AbortSignal.timeout(HANG_LIMIT_MS)]),
    })
  }
}

/** The call is refused before anyone is asked and again when it runs, with nothing signed, broadcast or recorded. */
export async function expectRefused<Spec extends ToolSpec, Fake>(
  rig: ToolRig<Spec, Fake>,
  args: unknown,
  code: ErrorCode,
  message: RegExp,
): Promise<void> {
  const approval = await rig.approve(args)
  assert.equal(approval.refused?.code, code)
  assert.match(approval.refused?.message ?? "", message)
  const error = await rig.run(args).catch((caught: unknown) => caught)
  assert.equal((error as ToolError | undefined)?.code, code)
  assert.equal(rig.broadcasts().length, 0)
  assert.deepEqual(await rig.rows(), [])
}

/**
 * The wallet `main` (Hardhat's first key) and `savings` (a seed phrase) are set up, with a fresh state directory and
 * the fixtures' clock. The fake mines when the wait first pauses. `define` makes the tool from the rig's node and
 * wait; `broadcastsOf` reads the transactions `fake` received.
 */
export function makeToolRig<Spec extends ToolSpec, Fake extends RigFake>(
  define: (deps: RigDeps) => Spec,
  fake: Fake,
  broadcastsOf: (fake: Fake) => string[],
  { wallets, options }: WalletRigOptions = {},
): ToolRig<Spec, Fake> {
  const stateDir = makeStateDir()
  stateDirs.push(stateDir)
  const env = wallets ?? { WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0, WEB3_TOOLS_WALLET_SAVINGS: ABANDON_PHRASE }
  const runtime = fakeRuntime(env, { now: () => NOW })
  const ctx: ToolContext = { cwd: process.cwd(), runtime, stateDir, ...(options && { options }) }
  const sleeps: number[] = []
  const rig: ToolRig<Spec, Fake> = {
    fake,
    stateDir,
    runtime,
    ctx,
    sleeps,
    mineAtMs: WAIT_POLL_MS,
    beforeRequest: undefined,
    tool: define({
      fetch: impatient(fake, () => rig.beforeRequest),
      env: {},
      sleep: async (ms, signal) => {
        signal?.throwIfAborted()
        const before = sleeps.reduce((total, paused) => total + paused, 0)
        sleeps.push(ms)
        if (rig.mineAtMs !== undefined && before < rig.mineAtMs && before + ms >= rig.mineAtMs) fake.mine()
      },
    }),
    cancel() {
      const controller = new AbortController()
      rig.ctx = { ...rig.ctx, signal: controller.signal }
      return controller
    },
    approve: (args) => approvalOf(rig.tool, args, rig.ctx),
    async run(args) {
      const approval = await rig.approve(args)
      if (approval.refused) throw approval.refused
      await checkPin(rig.tool, args, rig.ctx, approval.pin)
      return rig.invoke(args)
    },
    invoke(args) {
      sleeps.length = 0
      return invoke(rig.tool, args, rig.ctx) as Promise<z.output<Spec["output"]>>
    },
    rows: () => readLedger(stateDir),
    broadcasts: () => broadcastsOf(fake),
  }
  return rig
}
