import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { ToolError } from "../errors"
import { hashOf, RECIPIENT, SENDER } from "../ledger/testing"
import { readLedger, withLedger, type Ledger, type LedgerRow } from "../ledger/store"
import { fakeRuntime, makeStateDir } from "../signer/testing"
import type { ToolContext } from "../tool"
import { settleQuietly, writeUnderLock, type Rebuild, type SignedWrite, type WriteDriver } from "./pipeline"
import { NOW } from "./testing"
import type { WriteEnv, WritePlan } from "./types"

type Plan = WritePlan & { tag: string }

/** What the fake driver was asked, in order, and what the ledger held when it was asked to broadcast. */
type Trace = { calls: string[]; rowsAtBroadcast: LedgerRow[] }

const CONCURRENT_WAIT_MS = 80

let stateDir: string
let env: WriteEnv
let ctx: ToolContext

beforeEach(() => {
  stateDir = makeStateDir()
  const runtime = fakeRuntime({}, { now: () => NOW })
  env = { runtime, stateDir }
  ctx = { cwd: process.cwd(), runtime, stateDir }
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

function planOf(tag = "approved"): Plan {
  return {
    tag,
    sender: { label: "main", index: null, address: SENDER },
    ledger: { kind: "native", recipient: RECIPIENT, token: null, amount: "1" },
  }
}

function rebuildTo(plan: Plan, checks: { check?: () => Promise<void>; trace?: Trace } = {}): Rebuild<Plan> {
  return async () => ({
    plan,
    async check() {
      checks.trace?.calls.push("check")
      await checks.check?.()
    },
  })
}

type Behavior = {
  resolve?: () => Promise<void>
  sign?: () => Promise<void>
  broadcast?: (ledger: Ledger, row: LedgerRow) => Promise<ToolError | undefined>
}

/** A driver that records what it is asked and does what `behavior` says in each step. */
function driverOf(trace: Trace, hash: string, behavior: Behavior = {}): WriteDriver<Plan, void> {
  return {
    family: "evm",
    chain: "ethereum",
    async resolveOpenRows() {
      trace.calls.push("resolve")
      await behavior.resolve?.()
    },
    isSamePlan: (confirmed, rebuilt) => confirmed.tag === rebuilt.tag,
    async sign(): Promise<SignedWrite> {
      trace.calls.push("sign")
      await behavior.sign?.()
      return {
        hash,
        nonce: "0",
        last_valid_height: null,
        async broadcast(ledger, row) {
          trace.calls.push("broadcast")
          trace.rowsAtBroadcast.push(...ledger.rows)
          return behavior.broadcast?.(ledger, row)
        },
      }
    },
  }
}

function traceOf(): Trace {
  return { calls: [], rowsAtBroadcast: [] }
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("the locked path of a write", () => {
  test("the row is in the ledger as unknown before the driver broadcasts, and the call returns it", async () => {
    const trace = traceOf()
    const sent = await writeUnderLock(planOf(), rebuildTo(planOf(), { trace }), driverOf(trace, hashOf(1)), env, ctx)
    expect(trace.calls).toEqual(["resolve", "check", "sign", "broadcast"])
    expect(trace.rowsAtBroadcast).toEqual([sent.row])
    expect(sent.row).toMatchObject({
      family: "evm",
      chain: "ethereum",
      sender: SENDER,
      recipient: RECIPIENT,
      kind: "native",
      amount: "1",
      hash: hashOf(1),
      nonce: "0",
      last_valid_height: null,
      outcome: "unknown",
    })
    expect(sent.refusal).toBeUndefined()
    expect(await readLedger(stateDir)).toEqual([sent.row])
  })

  test("the broadcast's refusal is returned, not thrown, and the row stays", async () => {
    const trace = traceOf()
    const refusal = new ToolError("upstream_error", "The network refused it.")
    const driver = driverOf(trace, hashOf(1), { broadcast: async () => refusal })
    const sent = await writeUnderLock(planOf(), rebuildTo(planOf()), driver, env, ctx)
    expect(sent.refusal).toBe(refusal)
    expect(await readLedger(stateDir)).toEqual([sent.row])
  })

  test.each([
    ["resolving the open rows", { resolve: () => Promise.reject(new ToolError("stale", "held")) }, "resolve"],
    ["signing", { sign: () => Promise.reject(new ToolError("unauthenticated", "no key")) }, "sign"],
  ] as const)("an error while %s propagates, and no row exists", async (_step, behavior, last) => {
    const trace = traceOf()
    const error = await thrown(
      writeUnderLock(planOf(), rebuildTo(planOf()), driverOf(trace, hashOf(1), behavior), env, ctx),
    )
    expect(error).toBeInstanceOf(ToolError)
    expect(trace.calls.at(-1)).toBe(last)
    expect(trace.calls).not.toContain("broadcast")
    expect(await readLedger(stateDir)).toEqual([])
  })

  test("an error from the plan's check propagates, and nothing is signed or recorded", async () => {
    const trace = traceOf()
    const check = () => Promise.reject(new ToolError("invalid_argument", "The balance is too low."))
    const error = await thrown(
      writeUnderLock(planOf(), rebuildTo(planOf(), { check, trace }), driverOf(trace, hashOf(1)), env, ctx),
    )
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(trace.calls).toEqual(["resolve", "check"])
    expect(await readLedger(stateDir)).toEqual([])
  })

  test("a plan that changed is stale: nothing is checked, signed or recorded", async () => {
    const trace = traceOf()
    const error = await thrown(
      writeUnderLock(planOf(), rebuildTo(planOf("changed"), { trace }), driverOf(trace, hashOf(1)), env, ctx),
    )
    expect(error).toMatchObject({ code: "stale" })
    expect(trace.calls).toEqual(["resolve"])
    expect(await readLedger(stateDir)).toEqual([])
  })

  test("an error from the broadcast after the row does not throw, and the row stays unknown", async () => {
    const trace = traceOf()
    const driver = driverOf(trace, hashOf(1), { broadcast: () => Promise.reject(new Error("the node hung up")) })
    const sent = await writeUnderLock(planOf(), rebuildTo(planOf()), driver, env, ctx)
    expect(sent.refusal).toBeUndefined()
    expect(await readLedger(stateDir)).toEqual([sent.row])
    expect(sent.row.outcome).toBe("unknown")
  })

  test("a row that cannot be settled after the broadcast does not throw, and the row stays unknown", async () => {
    const trace = traceOf()
    const driver = driverOf(trace, hashOf(1), {
      broadcast: async (ledger) => {
        await settleQuietly(ledger, "0123456789abcdef", { outcome: "pending" })
        return undefined
      },
    })
    const sent = await writeUnderLock(planOf(), rebuildTo(planOf()), driver, env, ctx)
    expect(sent.refusal).toBeUndefined()
    expect((await readLedger(stateDir)).map((row) => row.outcome)).toEqual(["unknown"])
  })

  test("a row the broadcast settles is left as the driver settled it", async () => {
    const trace = traceOf()
    const driver = driverOf(trace, hashOf(1), {
      broadcast: async (ledger, row) => {
        await settleQuietly(ledger, row.id, { outcome: "pending" })
        return undefined
      },
    })
    await writeUnderLock(planOf(), rebuildTo(planOf()), driver, env, ctx)
    expect((await readLedger(stateDir)).map((row) => row.outcome)).toEqual(["pending"])
  })

  test("sends_per_hour refuses before the driver is asked anything", async () => {
    await withLedger(stateDir, env.runtime.now, async (ledger) => {
      await ledger.add({
        family: "evm",
        chain: "ethereum",
        sender: SENDER,
        ...planOf().ledger,
        hash: hashOf(9),
        nonce: "0",
        last_valid_height: null,
      })
    })
    const trace = traceOf()
    const limited: ToolContext = { ...ctx, options: { sends_per_hour: 1 } }
    const error = await thrown(
      writeUnderLock(planOf(), rebuildTo(planOf(), { trace }), driverOf(trace, hashOf(1)), env, limited),
    )
    expect(error).toMatchObject({ code: "rate_limited" })
    expect(trace.calls).toEqual([])
    expect(await readLedger(stateDir)).toHaveLength(1)
  })

  test("the lock is held through the broadcast: a second call waits for it", async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const first = traceOf()
    const second = traceOf()
    const firstDriver = driverOf(first, hashOf(1), {
      broadcast: async () => {
        await released
        return undefined
      },
    })
    const firstCall = writeUnderLock(planOf(), rebuildTo(planOf()), firstDriver, env, ctx)
    while (!first.calls.includes("broadcast")) await sleep(5)
    const secondCall = writeUnderLock(planOf(), rebuildTo(planOf()), driverOf(second, hashOf(2)), env, ctx)
    await sleep(CONCURRENT_WAIT_MS)
    expect(second.calls).toEqual([])
    release()
    await Promise.all([firstCall, secondCall])
    expect(second.rowsAtBroadcast.map((row) => row.hash)).toEqual([hashOf(1), hashOf(2)])
    expect((await readLedger(stateDir)).map((row) => row.hash)).toEqual([hashOf(1), hashOf(2)])
  })
})
