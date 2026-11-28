import { z } from "zod"
import { ToolError } from "../errors"

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/
const DIGITS = /^\d+$/
const KIND = /^[a-z0-9_]{1,32}$/

/** The longest note a row holds: fixed text the package writes, such as why a send was rejected. */
export const MAX_NOTE_LENGTH = 200

/** Where a row stands: `unknown` until the broadcast has an answer; `confirmed`, `failed` and `rejected` are final. */
export const OUTCOMES = ["unknown", "pending", "confirmed", "failed", "rejected"] as const

/** The outcomes a row can still leave, and where it can go. */
const TRANSITIONS: Readonly<Record<(typeof OUTCOMES)[number], readonly (typeof OUTCOMES)[number][]>> = {
  unknown: ["pending", "confirmed", "failed", "rejected"],
  pending: ["pending", "confirmed", "failed", "rejected"],
  confirmed: [],
  failed: [],
  rejected: [],
}

/** The outcomes that count as a send made: the funds may have moved or the fee was spent. */
const SENT_OUTCOMES: readonly (typeof OUTCOMES)[number][] = ["unknown", "pending", "confirmed", "failed"]

const digits = z.string().regex(DIGITS)

/** One line of the ledger: the whole row as of that change. */
export const ledgerRowSchema = z
  .strictObject({
    id: z.string().regex(/^[0-9a-f]{16}$/),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    family: z.enum(["evm", "solana"]),
    chain: z.string().min(1),
    sender: z.string().min(1),
    recipient: z.string().min(1),
    kind: z.string().regex(KIND),
    token: z.string().min(1).nullable(),
    amount: digits,
    hash: z.string(),
    nonce: digits.nullable(),
    last_valid_height: digits.nullable(),
    outcome: z.enum(OUTCOMES),
    block: digits.nullable(),
    note: z.string().max(MAX_NOTE_LENGTH).nullable(),
  })
  .refine((row) => (row.family === "evm" ? EVM_HASH : BASE58_SIGNATURE).test(row.hash), {
    path: ["hash"],
    message: "not a hash of the row's family",
  })

/** A row of the ledger. */
export type LedgerRow = z.infer<typeof ledgerRowSchema>

/** What a caller gives for a send about to be broadcast; the ledger adds the id, the times and `unknown`. */
export type NewLedgerRow = Omit<LedgerRow, "id" | "created_at" | "updated_at" | "outcome" | "block" | "note">

/** The fields that never change once a row is written. */
const IDENTITY_FIELDS = [
  "hash",
  "family",
  "chain",
  "sender",
  "nonce",
  "created_at",
] as const satisfies readonly (keyof LedgerRow)[]

/** What reading a ledger file gives. */
export type ParsedLedger = {
  /** The rows, in order of first appearance, each as of its last line. */
  rows: LedgerRow[]
  /** The byte offset a last line cut off by a crash starts at; absent when the file ends with a newline. */
  tornAt: number | undefined
}

/** Whether a row in `from` may move to `to`. */
export function canTransition(from: LedgerRow["outcome"], to: LedgerRow["outcome"]): boolean {
  return TRANSITIONS[from].includes(to)
}

/** The rows of the sends made at or after `sinceMs` (epoch milliseconds), in the order given. */
export function sentSince(rows: readonly LedgerRow[], sinceMs: number): LedgerRow[] {
  return rows.filter((row) => SENT_OUTCOMES.includes(row.outcome) && Date.parse(row.created_at) >= sinceMs)
}

/** Whether a row still awaits a result, so its sender sends nothing else on the chain. */
export function isOpen(row: LedgerRow): boolean {
  return row.outcome === "unknown" || row.outcome === "pending"
}

/** Whether two addresses or hashes of a family are the same: EVM ones ignore case. */
export function sameIdentifier(family: LedgerRow["family"], a: string, b: string): boolean {
  return family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The refusal for a file that cannot be read as it is, naming where. */
export function unreadableError(path: string, where: string): ToolError {
  return new ToolError(
    "internal_error",
    `The ledger at ${path} has ${where} that cannot be read; no send is made until it is fixed by hand.`,
  )
}

/** The row a valid line makes, or `internal_error` naming what is wrong with it. */
export function validRow(row: unknown): LedgerRow {
  const parsed = ledgerRowSchema.safeParse(row)
  if (!parsed.success) {
    throw new ToolError("internal_error", `A ledger row is not valid: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/** Whether `next` may follow `previous` as the same row's next line. */
function follows(previous: LedgerRow, next: LedgerRow): boolean {
  return (
    IDENTITY_FIELDS.every((field) => previous[field] === next[field]) && canTransition(previous.outcome, next.outcome)
  )
}

function parseLine(line: string): LedgerRow | undefined {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  const parsed = ledgerRowSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/**
 * Reads the text of a ledger file. A last fragment without a newline is a row
 * whose write never finished, so its broadcast never started: it is left out
 * and `tornAt` says where it starts, for a writer to cut it off. Any other line
 * that is not a row, or that follows its row by a change the rules forbid (an
 * identity field, a final outcome), is `internal_error` naming its line: a row
 * lost could be a hash sent.
 */
export function parseLedger(text: string, path: string): ParsedLedger {
  const lines = text.split("\n")
  const fragment = lines.pop() ?? ""
  const rows = new Map<string, LedgerRow>()
  for (const [index, line] of lines.entries()) {
    const row = parseLine(line)
    const previous = row && rows.get(row.id)
    if (!row || (previous && !follows(previous, row))) throw unreadableError(path, `a line ${index + 1}`)
    rows.set(row.id, row)
  }
  return {
    rows: [...rows.values()],
    tornAt: fragment === "" ? undefined : Buffer.byteLength(text) - Buffer.byteLength(fragment),
  }
}
