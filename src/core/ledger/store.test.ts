import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isToolError } from "../errors"
import { makeStateDir } from "../signer/testing"
import { readLedger, settleLedgerRow, withLedger } from "./store"
import { fileOf, hashOf, newRow, row, T0 } from "./testing"

const NOW = Date.parse(T0)
const LATER = "2026-01-01T00:05:00.000Z"
const MIXED_CASE = "0xAAbbCCddEEff00112233445566778899aaBBccDD"

let stateDir: string
let path: string

beforeEach(() => {
  stateDir = makeStateDir()
  path = join(stateDir, "ledger", "ledger.jsonl")
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

async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777
}

async function fileLines(): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
}

describe("adding and settling rows", () => {
  test("add appends an unknown row with a random id and the time, in files only its owner can use", async () => {
    const added = await withLedger(
      stateDir,
      () => NOW,
      (ledger) => ledger.add(newRow()),
    )
    expect(added).toEqual({ ...row(), id: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(await fileLines()).toEqual([added])
    expect(await modeOf(path)).toBe(0o600)
    expect(await modeOf(join(stateDir, "ledger"))).toBe(0o700)
  })

  test("settle appends the whole row as of the change and keeps the order of first appearance", async () => {
    let clock = NOW
    const [first, second] = await withLedger(
      stateDir,
      () => clock,
      async (ledger) => {
        const a = await ledger.add(newRow())
        const b = await ledger.add(newRow({ hash: hashOf(2), nonce: "8" }))
        clock = NOW + 300_000
        await ledger.settle(a.id, { outcome: "confirmed", block: "42" })
        return [a, b]
      },
    )
    expect((await fileLines()).length).toBe(3)
    expect(await readLedger(stateDir)).toEqual([
      { ...first, outcome: "confirmed", block: "42", updated_at: LATER },
      second,
    ])
  })

  test("a block and a note stay as they were unless the change gives them", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        const added = await ledger.add(newRow())
        await ledger.settle(added.id, { outcome: "pending", block: "5", note: "slow node" })
        const next = await ledger.settle(added.id, { outcome: "failed" })
        expect(next).toMatchObject({ outcome: "failed", block: "5", note: "slow node" })
        expect(ledger.rows).toEqual([next])
      },
    )
  })

  test("settling pending as pending with nothing new writes nothing", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        const added = await ledger.add(newRow())
        const pending = await ledger.settle(added.id, { outcome: "pending" })
        expect(await ledger.settle(added.id, { outcome: "pending" })).toBe(pending)
      },
    )
    expect(await fileLines()).toHaveLength(2)
  })

  test("a final row cannot change, and an unknown id or a long note is internal_error", async () => {
    const id = await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => (await ledger.add(newRow())).id,
    )
    await settleLedgerRow(stateDir, () => NOW, id, { outcome: "rejected", note: "replaced" })
    for (const attempt of [
      () => settleLedgerRow(stateDir, () => NOW, id, { outcome: "confirmed" }),
      () => settleLedgerRow(stateDir, () => NOW, "f".repeat(16), { outcome: "confirmed" }),
      () => settleLedgerRow(stateDir, () => NOW, id, { outcome: "rejected", note: "x".repeat(201) }),
    ]) {
      const error = await thrown(attempt())
      expect(isToolError(error) && error.code).toBe("internal_error")
    }
    expect(await fileLines()).toHaveLength(2)
  })

  test("settleLedgerRow takes the lock for one change after the send's own call ended", async () => {
    const id = await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => (await ledger.add(newRow())).id,
    )
    const settled = await settleLedgerRow(stateDir, () => NOW, id, { outcome: "confirmed", block: "9" })
    expect(settled).toMatchObject({ id, outcome: "confirmed", block: "9" })
    expect(await readLedger(stateDir)).toEqual([settled])
  })
})

describe("looking rows up", () => {
  test("find ignores case on EVM hashes; open lists the sender's unknown and pending rows on the chain", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        const lower = MIXED_CASE.toLowerCase()
        const a = await ledger.add(newRow({ hash: `0x${"AB".repeat(32)}`, sender: MIXED_CASE }))
        const b = await ledger.add(newRow({ hash: hashOf(2), sender: MIXED_CASE }))
        const done = await ledger.add(newRow({ hash: hashOf(3), sender: MIXED_CASE }))
        await ledger.add(newRow({ hash: hashOf(4), sender: MIXED_CASE, chain: "base" }))
        await ledger.add(newRow({ hash: hashOf(5), sender: "0x4444444444444444444444444444444444444444" }))
        await ledger.settle(b.id, { outcome: "pending" })
        await ledger.settle(done.id, { outcome: "confirmed" })
        expect(ledger.find(`0x${"ab".repeat(32)}`)?.id).toBe(a.id)
        expect(ledger.find(hashOf(99))).toBeUndefined()
        expect(ledger.open("evm", "ethereum", lower).map((entry) => entry.id)).toEqual([a.id, b.id])
        expect(ledger.open("solana", "ethereum", lower)).toEqual([])
      },
    )
  })

  test("sentSince counts the rows made at or after the time that are not rejected", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        const a = await ledger.add(newRow())
        const b = await ledger.add(newRow({ hash: hashOf(2) }))
        await ledger.settle(b.id, { outcome: "rejected" })
        await ledger.add(newRow({ hash: hashOf(3) }))
        expect(ledger.sentSince(NOW)).toBe(2)
        expect(ledger.sentSince(NOW + 1)).toBe(0)
        expect(a.created_at).toBe(T0)
      },
    )
  })
})

describe("a hash the ledger has seen", () => {
  test("is refused, whatever its case or outcome, and nothing is written", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        const added = await ledger.add(newRow({ hash: `0x${"ab".repeat(32)}` }))
        await ledger.settle(added.id, { outcome: "rejected" })
        const error = await thrown(ledger.add(newRow({ hash: `0x${"AB".repeat(32)}`, nonce: "9" })))
        expect(isToolError(error) && error.code).toBe("internal_error")
        expect(error).toMatchObject({ message: expect.stringContaining("never broadcast again") })
      },
    )
    expect(await fileLines()).toHaveLength(2)
  })

  test("is refused in a later call too", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      (ledger) => ledger.add(newRow()),
    )
    const error = await thrown(
      withLedger(
        stateDir,
        () => NOW,
        (ledger) => ledger.add(newRow()),
      ),
    )
    expect(isToolError(error) && error.code).toBe("internal_error")
  })

  test("an invalid row is internal_error and is not written", async () => {
    const error = await thrown(
      withLedger(
        stateDir,
        () => NOW,
        (ledger) => ledger.add(newRow({ hash: "0xabc" })),
      ),
    )
    expect(isToolError(error) && error.code).toBe("internal_error")
    expect(await stat(path).catch(() => undefined)).toBeUndefined()
  })
})

describe("a file a crash or a hand left behind", () => {
  test("a torn last line is cut off before the next row, and the rows before it stay", async () => {
    const earlier = row({ id: "a".repeat(16), hash: hashOf(1) })
    await mkdir(join(stateDir, "ledger"))
    await writeFile(path, `${fileOf(earlier)}{"id":"${"b".repeat(16)}","cre`, { mode: 0o600 })
    const added = await withLedger(
      stateDir,
      () => NOW,
      async (ledger) => {
        expect(ledger.rows).toEqual([earlier])
        return ledger.add(newRow({ hash: hashOf(2) }))
      },
    )
    expect(await readFile(path, "utf8")).toBe(fileOf(earlier, added))
  })

  test("a torn tail is left alone by a call that appends nothing, and by a read", async () => {
    await mkdir(join(stateDir, "ledger"))
    const text = `${fileOf(row())}{"id"`
    await writeFile(path, text, { mode: 0o600 })
    await withLedger(
      stateDir,
      () => NOW,
      async () => undefined,
    )
    expect(await readLedger(stateDir)).toEqual([row()])
    expect(await readFile(path, "utf8")).toBe(text)
  })

  test("a torn tail is cut after a multi-byte character with the byte offset, not the character count", async () => {
    const earlier = row({ id: "a".repeat(16), note: "résumé ✓" })
    await mkdir(join(stateDir, "ledger"))
    await writeFile(path, `${fileOf(earlier)}{"x":"é`, { mode: 0o600 })
    await withLedger(
      stateDir,
      () => NOW,
      (ledger) => ledger.settle(earlier.id, { outcome: "confirmed" }),
    )
    expect(await fileLines()).toEqual([earlier, { ...earlier, outcome: "confirmed", updated_at: T0 }])
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true)
  })

  test("a line in the middle that cannot be read stops every call, and nothing is written", async () => {
    await mkdir(join(stateDir, "ledger"))
    const text = `${fileOf(row())}garbage\n${fileOf(row({ id: "b".repeat(16), hash: hashOf(2) }))}`
    await writeFile(path, text, { mode: 0o600 })
    for (const attempt of [
      () =>
        withLedger(
          stateDir,
          () => NOW,
          async () => "ran",
        ),
      () => readLedger(stateDir),
      () => settleLedgerRow(stateDir, () => NOW, row().id, { outcome: "confirmed" }),
    ]) {
      const error = await thrown(attempt())
      expect(isToolError(error) && error.code).toBe("internal_error")
      expect(error).toMatchObject({ message: expect.stringContaining("has a line 2 that cannot be read") })
    }
    expect(await readFile(path, "utf8")).toBe(text)
  })

  test("bytes that are not text in a complete line stop every call", async () => {
    await mkdir(join(stateDir, "ledger"))
    await writeFile(path, Buffer.concat([Buffer.from(fileOf(row()).slice(0, -1)), Buffer.from([0xff, 0x0a])]))
    const error = await thrown(readLedger(stateDir))
    expect(error).toMatchObject({ message: expect.stringContaining("has bytes that cannot be read") })
  })

  test("a file cut off to nothing is an empty ledger", async () => {
    await withLedger(
      stateDir,
      () => NOW,
      (ledger) => ledger.add(newRow()),
    )
    await truncate(path, 0)
    expect(await readLedger(stateDir)).toEqual([])
  })
})

describe("reading", () => {
  test("a state root with no ledger gives no rows and creates nothing", async () => {
    expect(await readLedger(stateDir)).toEqual([])
    expect(await stat(join(stateDir, "ledger")).catch(() => undefined)).toBeUndefined()
  })
})
