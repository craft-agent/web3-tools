import { randomBytes } from "node:crypto"
import { link, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { clearInterval, setInterval } from "node:timers"
import { setTimeout as sleep } from "node:timers/promises"
import { isRecord } from "./describe"
import { ToolError } from "./errors"

/** The mode of the lock's directory and of every file written under it: the person's alone. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const LOCK_FILE = "lock"
const TEMP_FILE_RANDOM_BYTES = 4
const LOCK_TOKEN_BYTES = 16

const DEFAULT_TIMEOUT_MS = 5000
/** A lock untouched for this long was left by a call that died. */
const DEFAULT_STALE_MS = 30_000
/** The lock file is touched this many times within the stale age, so a holder that is only slow is never taken for a dead one. */
const REFRESHES_PER_STALE_AGE = 3
const RETRY_MIN_MS = 25
const RETRY_JITTER_MS = 25

/** How a lock is named, waited for and kept alive. */
export type LockOptions = {
  /** What the lock guards, as its messages name it (`grants`, `ledger`). */
  name: string
  /** How long a call waits for the lock; 5 seconds by default. */
  timeoutMs?: number
  /** The age of an untouched lock file after which another call takes it over; 30 seconds by default. */
  staleMs?: number
  /** How often the holder touches the lock file; a third of `staleMs` by default. */
  refreshMs?: number
  /** The error for a call that cannot take the lock in time; `internal_error` by default. */
  busy?: () => ToolError
}

/** The lock a call holds; a write made under it first asks `assertHeld`, so a call whose lock was taken over never writes. */
export type HeldLock = {
  /** Throws `internal_error` when the lock file no longer holds this call's token. */
  assertHeld: () => Promise<void>
}

/** Writes a file whole: to a temporary file beside it, then, with the lock still held, renamed over it. */
export async function writeAtomic(path: string, text: string, lock: HeldLock): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(TEMP_FILE_RANDOM_BYTES).toString("hex")}.tmp`
  try {
    await writeFile(temporary, text, { mode: FILE_MODE })
    await lock.assertHeld()
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Whether an error is the system's, with this code (`ENOENT`). */
export function hasSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

/** Takes the lock file, writing the call's token into it; false when another call holds it. */
async function takeLock(path: string, token: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, "wx", FILE_MODE)
  } catch (error) {
    if (hasSystemCode(error, "EEXIST")) return false
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })}\n`)
  } catch (error) {
    await rm(path, { force: true })
    throw error
  } finally {
    await handle.close()
  }
  return true
}

/** Whether the lock file holds this token: false when it is gone, unreadable as a lock or another call's. */
async function holdsLock(path: string, token: string): Promise<boolean> {
  try {
    const content: unknown = JSON.parse(await readFile(path, "utf8"))
    return isRecord(content) && content.token === token
  } catch (error) {
    if (error instanceof SyntaxError || hasSystemCode(error, "ENOENT")) return false
    throw error
  }
}

function lostLockError(name: string, dir: string): ToolError {
  return new ToolError(
    "internal_error",
    `The ${name} lock in ${dir} was lost: it went stale and another call took it over. Nothing was written.`,
  )
}

function defaultBusyError(name: string, dir: string, path: string, timeoutMs: number): ToolError {
  return new ToolError(
    "internal_error",
    `Could not take the ${name} lock in ${dir} within ${timeoutMs / 1000} s; another call may be stuck. Remove ${path} if no call is running.`,
  )
}

/**
 * Clears a lock a dead or stalled call left behind; true when the caller
 * should retry at once. The stale file is first renamed to a name of this
 * call's own, which only one of several waiters can do. If what was renamed
 * turns out to be fresh (a new owner took the lock between the check and the
 * rename), it is linked back when `lock` is still absent and dropped otherwise;
 * either way its owner finds its token missing before its next write.
 */
async function reclaimStaleLock(path: string, token: string, staleMs: number): Promise<boolean> {
  try {
    if (Date.now() - (await stat(path)).mtimeMs <= staleMs) return false
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return true
    throw error
  }
  const claimed = `${path}.${token}.stale`
  try {
    await rename(path, claimed)
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return true
    throw error
  }
  try {
    if (Date.now() - (await stat(claimed)).mtimeMs <= staleMs) {
      await link(claimed, path).catch((error: unknown) => {
        if (!hasSystemCode(error, "EEXIST")) throw error
      })
    }
  } finally {
    await rm(claimed, { force: true })
  }
  return true
}

/**
 * Touches the lock file every `refreshMs` while it still holds this token, so
 * that a slow holder keeps it. A failed touch is left to `assertHeld`, which
 * reports a lock that was lost; the timer never keeps the process alive.
 */
function keepFresh(path: string, token: string, refreshMs: number): () => void {
  const timer = setInterval(() => {
    void (async () => {
      if (!(await holdsLock(path, token))) return
      const now = new Date()
      await utimes(path, now, now)
    })().catch(() => undefined)
  }, refreshMs)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * Runs `fn` while holding the directory's lock, so that calls from several
 * processes change the files one at a time. The lock file holds a random token
 * of this call, and its modification time is refreshed while `fn` runs. A call
 * that finds the lock taken retries until `timeoutMs` and then throws `busy`,
 * and takes over a lock file not touched for `staleMs`; `fn` gets the lock and
 * must pass it to every write, which then fails with `internal_error` if the
 * lock was taken over meanwhile. The lock is released only if it still holds
 * this call's token.
 */
export async function withLock<T>(dir: string, fn: (lock: HeldLock) => Promise<T>, options: LockOptions): Promise<T> {
  const { name, timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = options
  const { refreshMs = staleMs / REFRESHES_PER_STALE_AGE } = options
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  const path = join(dir, LOCK_FILE)
  const token = randomBytes(LOCK_TOKEN_BYTES).toString("hex")
  const deadline = Date.now() + timeoutMs
  while (!(await takeLock(path, token))) {
    if (await reclaimStaleLock(path, token, staleMs)) continue
    if (Date.now() >= deadline) throw options.busy?.() ?? defaultBusyError(name, dir, path, timeoutMs)
    await sleep(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS)
  }
  const lock: HeldLock = {
    assertHeld: async () => {
      if (!(await holdsLock(path, token))) throw lostLockError(name, dir)
    },
  }
  const stopRefreshing = keepFresh(path, token, refreshMs)
  try {
    return await fn(lock)
  } finally {
    stopRefreshing()
    if (await holdsLock(path, token)) await rm(path, { force: true })
  }
}

/**
 * Runs `fn` as a reader would: under the lock, so that it never sees a line a
 * writer is still appending. A directory that does not exist holds nothing a
 * writer could be changing, so `fn` runs at once and nothing is created.
 */
export async function withReadLock<T>(dir: string, fn: () => Promise<T>, options: LockOptions): Promise<T> {
  try {
    await stat(dir)
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return fn()
    throw error
  }
  return withLock(dir, fn, options)
}
