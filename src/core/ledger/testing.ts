import type { LedgerRow, NewLedgerRow } from "./rows"

/** The hash `n` stands for: `0x` and 64 hex digits. */
export function hashOf(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`
}

export const SENDER = "0x1111111111111111111111111111111111111111"
export const RECIPIENT = "0x2222222222222222222222222222222222222222"
export const T0 = "2026-01-01T00:00:00.000Z"

/** What a send gives the ledger before its broadcast; `overrides` replace fields. */
export function newRow(overrides: Partial<NewLedgerRow> = {}): NewLedgerRow {
  return {
    family: "evm",
    chain: "ethereum",
    sender: SENDER,
    recipient: RECIPIENT,
    kind: "native",
    token: null,
    amount: "1000",
    hash: hashOf(1),
    nonce: "7",
    last_valid_height: null,
    ...overrides,
  }
}

/** A whole row as stored; `overrides` replace fields. */
export function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: "0123456789abcdef",
    created_at: T0,
    updated_at: T0,
    outcome: "unknown",
    block: null,
    note: null,
    ...newRow(),
    ...overrides,
  }
}

/** The text of a ledger file holding these rows, one line each. */
export function fileOf(...rows: LedgerRow[]): string {
  return rows.map((entry) => `${JSON.stringify(entry)}\n`).join("")
}
