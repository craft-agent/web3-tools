import { randomBytes } from "node:crypto"
import { open, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { TextDecoder } from "node:util"
import { ToolError } from "../errors"
import { hasSystemCode, withLock, withReadLock, type HeldLock, type LockOptions } from "../lock"
import { ensurePrivateDir } from "../signer/private-dir"
import {
  canTransition,
  isOpen,
  parseLedger,
  sameIdentifier,
  sentSince,
  unreadableError,
  validRow,
  type LedgerRow,
  type NewLedgerRow,
  type ParsedLedger,
} from "./rows"

export { checkSendsPerHour, sendsPerHour } from "./limit"
export type { LedgerRow, NewLedgerRow } from "./rows"

const LEDGER_DIR = "ledger"
const LEDGER_FILE = "ledger.jsonl"
const FILE_MODE = 0o600
const NEWLINE = 0x0a
const ID_BYTES = 8

const LOCK_TIMEOUT_MS = 60_000
const LOCK_STALE_MS = 30_000
const BUSY_RETRY_AFTER_S = 5

/** How the ledger's lock is taken and kept; a test shortens its waits by passing its own to `withLedger`. */
export const LEDGER_LOCK: LockOptions = {
  name: "ledger",
  timeoutMs: LOCK_TIMEOUT_MS,
  staleMs: LOCK_STALE_MS,
  busy: () =>
    new ToolError("rate_limited", "Another send holds the ledger; try again shortly.", {
      details: { retry_after_s: BUSY_RETRY_AFTER_S },
    }),
}

/** How a row changes: its new outcome, and the block and note when they change too. */
export type LedgerChange = Pick<LedgerRow, "outcome"> & { block?: LedgerRow["block"]; note?: LedgerRow["note"] }

/** The ledger as `withLedger` hands it out: the rows read under the lock, kept in step with what is appended. */
export type Ledger = {
  /** The rows in order of first appearance, each as of its last line. */
  readonly rows: readonly LedgerRow[]
  /** The row with this hash (EVM hashes ignore case). */
  find(hash: string): LedgerRow | undefined
  /** The rows of this sender on this chain that await a result (`unknown` or `pending`). */
  open(family: LedgerRow["family"], chain: string, sender: string): LedgerRow[]
  /** How many sends (`unknown`, `pending`, `confirmed` or `failed`) were made at or after `ms`, in epoch milliseconds. */
  sentSince(ms: number): number
  /**
   * Appends a row as `unknown`, flushed to disk before it returns. A hash the
   * ledger has seen is refused with `internal_error`: it is never broadcast again.
   */
  add(row: NewLedgerRow): Promise<LedgerRow>
  /** Appends the row's next line; `internal_error` for an id the ledger lacks or a change the rules forbid. */
  settle(id: string, change: LedgerChange): Promise<LedgerRow>
}

function ledgerDir(stateDir: string): string {
  return join(stateDir, LEDGER_DIR)
}

/** Reads the file; a missing one is an empty ledger. Its complete lines must be valid text, so that `tornAt` is a byte offset. */
async function loadLedger(path: string): Promise<ParsedLedger & { existed: boolean }> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (hasSystemCode(error, "ENOENT")) return { rows: [], tornAt: undefined, existed: false }
    throw error
  }
  const complete = bytes.subarray(0, bytes.lastIndexOf(NEWLINE) + 1)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(complete)
  } catch {
    throw unreadableError(path, "bytes")
  }
  return { ...parseLedger(text + bytes.subarray(complete.length).toString("utf8"), path), existed: true }
}

/** Makes the new file's directory entry durable, so a row flushed into it is still found after a crash. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function newLedger(
  path: string,
  loaded: ParsedLedger & { existed: boolean },
  lock: HeldLock,
  now: () => number,
): Ledger {
  const rows = [...loaded.rows]
  let tornAt = loaded.tornAt
  let fileMissing = !loaded.existed

  async function append(row: LedgerRow): Promise<void> {
    await lock.assertHeld()
    const handle = await open(path, "a", FILE_MODE)
    try {
      if (tornAt !== undefined) {
        await handle.truncate(tornAt)
        tornAt = undefined
      }
      await handle.writeFile(`${JSON.stringify(row)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (fileMissing) {
      await syncDirectory(dirname(path))
      fileMissing = false
    }
  }

  function newId(): string {
    for (;;) {
      const id = randomBytes(ID_BYTES).toString("hex")
      if (!rows.some((row) => row.id === id)) return id
    }
  }

  const ledger: Ledger = {
    rows,
    find: (hash) => rows.find((row) => sameIdentifier(row.family, row.hash, hash)),
    open: (family, chain, sender) =>
      rows.filter(
        (row) =>
          row.family === family && row.chain === chain && sameIdentifier(family, row.sender, sender) && isOpen(row),
      ),
    sentSince: (ms) => sentSince(rows, ms).length,
    async add(input) {
      if (ledger.find(input.hash)) {
        throw new ToolError(
          "internal_error",
          `The ledger has seen the hash ${input.hash}; a hash the ledger has seen is never broadcast again.`,
        )
      }
      const at = new Date(now()).toISOString()
      const row = validRow({
        ...input,
        id: newId(),
        created_at: at,
        updated_at: at,
        outcome: "unknown",
        block: null,
        note: null,
      })
      await append(row)
      rows.push(row)
      return row
    },
    async settle(id, change) {
      const index = rows.findIndex((row) => row.id === id)
      const row = rows[index]
      if (!row) throw new ToolError("internal_error", `The ledger has no row ${id}.`)
      if (!canTransition(row.outcome, change.outcome)) {
        throw new ToolError(
          "internal_error",
          `The ledger row ${id} is ${row.outcome} and cannot become ${change.outcome}.`,
        )
      }
      const next = validRow({
        ...row,
        outcome: change.outcome,
        block: change.block === undefined ? row.block : change.block,
        note: change.note === undefined ? row.note : change.note,
        updated_at: new Date(now()).toISOString(),
      })
      if (
        row.outcome === "pending" &&
        next.outcome === "pending" &&
        next.block === row.block &&
        next.note === row.note
      ) {
        return row
      }
      await append(next)
      rows[index] = next
      return next
    },
  }
  return ledger
}

/**
 * Runs `fn` with the ledger under its lock, so that two sends never race: the
 * rows are read once, after the lock is taken, and `fn` sees what the call
 * before it appended. A call that cannot take the lock in 60 seconds is
 * `rate_limited`. The state root's `ledger` directory is made with mode 700 and
 * the file with mode 600. A last line cut off by a crash is cut from the file
 * before the first line is appended; any other line that cannot be read is
 * `internal_error`, and `fn` does not run.
 */
export async function withLedger<T>(
  stateDir: string,
  now: () => number,
  fn: (ledger: Ledger) => Promise<T>,
  lockOptions: LockOptions = LEDGER_LOCK,
): Promise<T> {
  const dir = ledgerDir(stateDir)
  await ensurePrivateDir(dir)
  const path = join(dir, LEDGER_FILE)
  return withLock(dir, async (lock) => fn(newLedger(path, await loadLedger(path), lock, now)), lockOptions)
}

/** The rows as of now, read under the lock; none, and nothing created, when no send was ever made. */
export async function readLedger(stateDir: string): Promise<readonly LedgerRow[]> {
  const dir = ledgerDir(stateDir)
  return withReadLock(dir, async () => (await loadLedger(join(dir, LEDGER_FILE))).rows, LEDGER_LOCK)
}

/** Changes one row under the lock, for an update after the broadcast, which the call's own `withLedger` no longer holds. */
export function settleLedgerRow(
  stateDir: string,
  now: () => number,
  id: string,
  change: LedgerChange,
): Promise<LedgerRow> {
  return withLedger(stateDir, now, (ledger) => ledger.settle(id, change))
}
