import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { isToolError, ToolError } from "./errors"
import { withLock, withReadLock, type LockOptions } from "./lock"

const STALE_MS = 200
const HELD_FOR_MS = 600
const POLL_MS = 5
const NEVER_MS = 1_000_000_000

const SHORT: LockOptions = { name: "demo", staleMs: STALE_MS, timeoutMs: 5000 }

let root: string
let dir: string
let lockPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lock-"))
  dir = join(root, "demo")
  lockPath = join(dir, "lock")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

async function lockToken(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")).token
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

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

describe("a lock that is refreshed", () => {
  test("a holder that outlasts the stale age keeps the lock and the waiter runs after it", async () => {
    const events: string[] = []
    const holder = withLock(
      dir,
      async (lock) => {
        events.push("holder in")
        const mtimeAtStart = (await stat(lockPath)).mtimeMs
        await sleep(HELD_FOR_MS)
        expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(mtimeAtStart)
        await lock.assertHeld()
        events.push("holder out")
      },
      SHORT,
    )
    await tokenOtherThan(undefined)
    const waiter = withLock(dir, async () => void events.push("waiter in"), SHORT)
    await Promise.all([holder, waiter])
    expect(events).toEqual(["holder in", "holder out", "waiter in"])
  })

  test("without refresh the lock goes stale, is taken over, and the first holder's assertHeld fails", async () => {
    const stalled = gate()
    const second = gate()
    const holder = thrown(
      withLock(
        dir,
        async (lock) => {
          await stalled.opened
          await lock.assertHeld()
        },
        { ...SHORT, refreshMs: NEVER_MS },
      ),
    )
    const firstToken = await tokenOtherThan(undefined)
    const takenOver = withLock(dir, () => second.opened, SHORT)
    const secondToken = await tokenOtherThan(firstToken)

    stalled.open()
    const error = await holder
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(error).toMatchObject({ message: expect.stringContaining("The demo lock") })
    expect(await lockToken()).toBe(secondToken)
    second.open()
    await takenOver
  })

  test("the lock file is not touched again once the lock is released", async () => {
    await withLock(dir, async () => undefined, { ...SHORT, refreshMs: 10 })
    await sleep(60)
    expect(await stat(lockPath).catch(() => undefined)).toBeUndefined()
  })
})

describe("a lock that cannot be taken", () => {
  test("the busy error is thrown after the timeout", async () => {
    const held = gate()
    const holder = withLock(dir, () => held.opened, SHORT)
    await tokenOtherThan(undefined)
    const busy = () => new ToolError("rate_limited", "Another send holds it.", { details: { retry_after_s: 5 } })
    const error = await thrown(withLock(dir, async () => undefined, { ...SHORT, timeoutMs: 80, busy }))
    expect(isToolError(error) && error.code).toBe("rate_limited")
    expect(isToolError(error) && error.details).toEqual({ retry_after_s: 5 })
    held.open()
    await holder
  })

  test("without a busy error the call fails as internal_error naming the lock", async () => {
    const held = gate()
    const holder = withLock(dir, () => held.opened, SHORT)
    await tokenOtherThan(undefined)
    const error = await thrown(withLock(dir, async () => undefined, { ...SHORT, timeoutMs: 80 }))
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(error).toMatchObject({ message: expect.stringContaining("the demo lock") })
    held.open()
    await holder
  })
})

describe("withReadLock", () => {
  test("runs at once and creates nothing when the directory does not exist", async () => {
    expect(await withReadLock(dir, async () => "read", SHORT)).toBe("read")
    expect(await stat(dir).catch(() => undefined)).toBeUndefined()
  })
})
