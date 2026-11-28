import type { ToolRuntime } from "../runtime"

/** What a write waits for: it lands and succeeds, lands and fails (the fee is spent), or has no result yet. */
export const WRITE_OUTCOMES = ["confirmed", "failed", "pending"] as const

/** How a write stands when the call returns. */
export type WriteOutcome = (typeof WRITE_OUTCOMES)[number]

/** What `requireRuntime` names when a call lacks the runtime or the state directory a send needs. */
export const SEND_SUBJECT = "Sends"

/** The account that sends: wallet `label`, its index in a seed phrase (`null` for a lone key) and its address. */
export type WriteSender = { label: string; index: number | null; address: string }

/** What the ledger records of a write: the kind of its row, who it is for, the token and the amount in digits. */
export type LedgerEntry = { kind: string; recipient: string; token: string | null; amount: string }

/** The part of a plan every family's write shares: who sends, and what the ledger records. */
export type WritePlan = { sender: WriteSender; ledger: LedgerEntry }

/** What every write needs of a call, whatever the family: its runtime and the state directory the ledger lives in. */
export type WriteEnv = { runtime: ToolRuntime; stateDir: string }
