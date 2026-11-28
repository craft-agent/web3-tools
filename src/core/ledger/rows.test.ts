import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { canTransition, parseLedger, sentSince } from "./rows"
import { fileOf, hashOf, row, T0 } from "./testing"

const PATH = "/state/ledger/ledger.jsonl"

function failure(text: string): unknown {
  try {
    parseLedger(text, PATH)
  } catch (error) {
    return error
  }
  return undefined
}

function unreadable(text: string, where: string): void {
  const error = failure(text)
  expect(isToolError(error) && error.code).toBe("internal_error")
  expect(error).toMatchObject({
    message: `The ledger at ${PATH} has ${where} that cannot be read; no send is made until it is fixed by hand.`,
  })
}

describe("parseLedger", () => {
  test("an empty file holds no rows and no torn tail", () => {
    expect(parseLedger("", PATH)).toEqual({ rows: [], tornAt: undefined })
  })

  test("rows come in order of first appearance, each as of its last line", () => {
    const a = row({ id: "aaaaaaaaaaaaaaaa", hash: hashOf(1) })
    const b = row({ id: "bbbbbbbbbbbbbbbb", hash: hashOf(2) })
    const settled = { ...a, outcome: "confirmed", block: "12", updated_at: "2026-01-01T00:01:00.000Z" } as const
    expect(parseLedger(fileOf(a, b, settled), PATH).rows).toEqual([settled, b])
  })

  test("a last fragment without a newline is ignored and its byte offset reported", () => {
    const first = fileOf(row())
    const fragment = `{"id":"${"b".repeat(16)}","note":"é`
    const parsed = parseLedger(first + fragment, PATH)
    expect(parsed.rows).toEqual([row()])
    expect(parsed.tornAt).toBe(Buffer.byteLength(first))
  })

  test("a whole row missing only its newline is a torn write too", () => {
    const text = JSON.stringify(row())
    expect(parseLedger(text, PATH)).toEqual({ rows: [], tornAt: 0 })
  })

  test("a bad line in the middle is refused with its number", () => {
    unreadable(`${fileOf(row())}not json\n${fileOf(row({ id: "bbbbbbbbbbbbbbbb", hash: hashOf(2) }))}`, "a line 2")
    unreadable(`\n${fileOf(row())}`, "a line 1")
    unreadable(fileOf(row({ outcome: "lost" as never })), "a line 1")
  })

  test("a row with a field the schema does not know, or a malformed one, is refused", () => {
    unreadable(`${JSON.stringify({ ...row(), extra: 1 })}\n`, "a line 1")
    unreadable(fileOf(row({ amount: "1.5" })), "a line 1")
    unreadable(fileOf(row({ kind: "Native" })), "a line 1")
    unreadable(fileOf(row({ hash: "0xabc" })), "a line 1")
    unreadable(fileOf(row({ id: "ABCDEF0123456789" })), "a line 1")
    unreadable(fileOf(row({ note: "x".repeat(201) })), "a line 1")
  })

  test("a Solana row takes a base58 signature and no 0x hash", () => {
    const signature = "5".repeat(88)
    expect(parseLedger(fileOf(row({ family: "solana", hash: signature })), PATH).rows).toHaveLength(1)
    unreadable(fileOf(row({ family: "solana", hash: hashOf(1) })), "a line 1")
  })

  test.each(["unknown", "pending", "confirmed", "failed", "rejected"] as const)(
    "a line after a final row is refused: %s",
    (outcome) => {
      const final = row({ outcome: "confirmed" })
      const again = row({ outcome, updated_at: "2026-01-01T00:02:00.000Z" })
      unreadable(fileOf(final, again), "a line 2")
    },
  )

  test("a row cannot go back to unknown, and unknown cannot repeat", () => {
    unreadable(fileOf(row({ outcome: "pending" }), row({ outcome: "unknown" })), "a line 2")
    unreadable(fileOf(row(), row()), "a line 2")
  })

  test("pending may repeat and may move on", () => {
    const pending = row({ outcome: "pending" })
    expect(
      parseLedger(fileOf(row(), pending, { ...pending, block: "5" }, { ...pending, outcome: "failed" }), PATH).rows,
    ).toEqual([{ ...pending, outcome: "failed" }])
  })

  test.each([
    ["hash", { hash: hashOf(9) }],
    ["family", { family: "solana" }],
    ["chain", { chain: "base" }],
    ["sender", { sender: "0x3333333333333333333333333333333333333333" }],
    ["nonce", { nonce: "8" }],
    ["created_at", { created_at: "2026-01-02T00:00:00.000Z" }],
  ] as const)("a later line that changes %s is refused", (_field, change) => {
    unreadable(fileOf(row(), row({ ...change, outcome: "pending" })), "a line 2")
  })
})

describe("canTransition", () => {
  test("unknown and pending lead on; the rest are final", () => {
    expect(canTransition("unknown", "pending")).toBe(true)
    expect(canTransition("unknown", "unknown")).toBe(false)
    expect(canTransition("pending", "pending")).toBe(true)
    expect(canTransition("pending", "unknown")).toBe(false)
    for (const final of ["confirmed", "failed", "rejected"] as const) {
      for (const to of ["unknown", "pending", "confirmed", "failed", "rejected"] as const) {
        expect(canTransition(final, to)).toBe(false)
      }
    }
  })
})

describe("sentSince", () => {
  test("counts rows created at or after the time whose outcome is not rejected", () => {
    const at = Date.parse(T0)
    const rows = [
      row({ id: "a".repeat(16), outcome: "unknown" }),
      row({ id: "b".repeat(16), outcome: "rejected" }),
      row({ id: "c".repeat(16), outcome: "failed", created_at: "2025-12-31T23:59:59.999Z" }),
    ]
    expect(sentSince(rows, at).map((entry) => entry.id)).toEqual(["a".repeat(16)])
    expect(sentSince(rows, at - 1).map((entry) => entry.id)).toEqual(["a".repeat(16), "c".repeat(16)])
  })
})
