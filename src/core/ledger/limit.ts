import { ToolError } from "../errors"
import type { ToolContext } from "../tool"
import { sentSince } from "./rows"
import type { Ledger } from "./store"

/** The name of the option that caps the sends of every wallet together. */
const SENDS_PER_HOUR_OPTION = "sends_per_hour"

/** The window `sends_per_hour` counts over. */
const WINDOW_MS = 60 * 60 * 1000
const MS_PER_S = 1000

/** The `sends_per_hour` option; `undefined` when unset, `internal_error` when what was parsed is not a whole number from 1. */
export function sendsPerHour(ctx: ToolContext): number | undefined {
  const value = ctx.options?.[SENDS_PER_HOUR_OPTION]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolError("internal_error", `The option ${SENDS_PER_HOUR_OPTION} must be a whole number from 1.`)
  }
  return value
}

/**
 * Refuses a send that would be past `limit` sends (`unknown`, `pending`,
 * `confirmed` and `failed` rows) in the 60 minutes up to `now`, as
 * `rate_limited` with `details.retry_after_s`: the seconds until enough of the
 * counted rows have left the window for one more send. No limit counts nothing.
 */
export function checkSendsPerHour(ledger: Pick<Ledger, "rows">, limit: number | undefined, now: number): void {
  if (limit === undefined) return
  const counted = sentSince(ledger.rows, now - WINDOW_MS).sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  )
  if (counted.length < limit) return
  const leaving = Date.parse(counted[counted.length - limit]!.created_at) + WINDOW_MS
  const retryAfter = Math.max(1, Math.ceil((leaving - now) / MS_PER_S))
  throw new ToolError(
    "rate_limited",
    `The ${SENDS_PER_HOUR_OPTION} limit of ${limit} is reached: ${counted.length} sends in the last 60 minutes. Try again in ${retryAfter} s or raise the setting.`,
    { details: { retry_after_s: retryAfter } },
  )
}
