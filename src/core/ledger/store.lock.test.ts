import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { isToolError } from "../errors"
import type { LockOptions } from "../lock"
import { makeStateDir } from "../signer/testing"
import { LEDGER_LOCK, readLedger, withLedger } from "./store"
import { hashOf, newRow, T0 } from "./testing"

const NOW = Date.parse(T0)
const STALE_MS = 200
const HELD_FOR_MS = 600
const POLL_MS = 5
const NEVER_MS = 1_000_000_000

const SHORT: LockOptions = { ...LEDGER_LOCK, staleMs: STALE_MS, timeoutMs: 5000 }

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

async function lockToken(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(stateDir, "ledger", "lock"), "utf8")).token
  } catch {
    return undefined
  }
}

async function tokenOtherThan(previous: unknown): Promise<string> {
  for (;;) {
    const token = await lockToken()
    if (typeof token === "string" && token !== previous) return token
    await sleep(POLL_MS)
  }
}

describe("two sends at once", () => {
  test("run one after the other, and the second sees the row the first appended", async () => {
    const held = gate()
    const first = withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        await ledger.add(newRow({ hash: hashOf(1) }))
        await held.opened
      },
    )
    await tokenOtherThan(undefined)
    let seen: string[] = []
    const second = withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        seen = ledger.rows.map((row) => row.hash)
        await ledger.add(newRow({ hash: hashOf(2), nonce: "8" }))
      },
    )
    await sleep(60)
    expect(seen).toEqual([])
    held.open()
    await Promise.all([first, second])
    expect(seen).toEqual([hashOf(1)])
    expect((await readLedger(stateDir)).map((row) => row.hash)).toEqual([hashOf(1), hashOf(2)])
  })

  test("the same hash from both is added once, and the second is refused", async () => {
    const calls = [1, 2].map(() =>
      thrown(
        withLedger(
          stateDir,
          () => NOW,
          (ledger) => ledger.add(newRow()),
        ),
      ),
    )
    const errors = (await Promise.all(calls)).filter((error) => error !== undefined)
    expect(errors).toHaveLength(1)
    expect(await readLedger(stateDir)).toHaveLength(1)
  })
})

describe("the ledger's lock", () => {
  test("a holder that outlasts the stale age keeps it, thanks to the refresh", async () => {
    const order: string[] = []
    const holder = withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        await ledger.add(newRow({ hash: hashOf(1) }))
        await sleep(HELD_FOR_MS)
        await ledger.add(newRow({ hash: hashOf(2), nonce: "8" }))
        order.push("holder")
      },
      SHORT,
    )
    await tokenOtherThan(undefined)
    const waiter = withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        order.push(`waiter saw ${ledger.rows.length}`)
      },
      SHORT,
    )
    await Promise.all([holder, waiter])
    expect(order).toEqual(["holder", "waiter saw 2"])
  })

  test("a holder whose lock went stale and was taken over appends nothing", async () => {
    const stalled = gate()
    const second = gate()
    const holder = thrown(
      withLedger(
        stateDir,
        () => NOW,
        async (ledger) => {
          await stalled.opened
          await ledger.add(newRow({ hash: hashOf(1) }))
        },
        { ...SHORT, refreshMs: NEVER_MS },
      ),
    )
    const firstToken = await tokenOtherThan(undefined)
    const takenOver = withLedger(
      stateDir,
      () => NOW,
      () => second.opened,
      SHORT,
    )
    await tokenOtherThan(firstToken)
    stalled.open()
    const error = await holder
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(error).toMatchObject({ message: expect.stringContaining("The ledger lock") })
    second.open()
    await takenOver
    expect(await readLedger(stateDir)).toEqual([])
  })

  test("a call that cannot take it in time is rate_limited and says when to retry", async () => {
    const held = gate()
    const holder = withLedger(
      stateDir,
      () => NOW,
      () => held.opened,
    )
    await tokenOtherThan(undefined)
    const error = await thrown(
      withLedger(
        stateDir,
        () => NOW,
        async () => "ran",
        { ...LEDGER_LOCK, timeoutMs: 80 },
      ),
    )
    expect(isToolError(error) && error.code).toBe("rate_limited")
    expect(isToolError(error) && error.details).toEqual({ retry_after_s: 5 })
    expect(error).toMatchObject({ message: "Another send holds the ledger; try again shortly." })
    held.open()
    await holder
  })
})
