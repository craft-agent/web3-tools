import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import type { ToolContext } from "../tool"
import { checkSendsPerHour, sendsPerHour } from "./limit"
import type { Ledger, LedgerRow } from "./store"
import { hashOf, row, T0 } from "./testing"

const NOW = Date.parse(T0)
const MINUTE_MS = 60_000

/** A ledger of rows made `minutesAgo` minutes before `NOW`, with the outcomes given. */
function ledgerOf(...made: [minutesAgo: number, outcome: LedgerRow["outcome"]][]): Pick<Ledger, "rows"> {
  const rows = made.map(([minutesAgo, outcome], index) =>
    row({
      id: index.toString(16).padStart(16, "0"),
      hash: hashOf(index + 1),
      outcome,
      created_at: new Date(NOW - minutesAgo * MINUTE_MS).toISOString(),
    }),
  )
  return { rows }
}

function refusal(ledger: Pick<Ledger, "rows">, limit: number | undefined, now = NOW): unknown {
  try {
    checkSendsPerHour(ledger, limit, now)
  } catch (error) {
    return error
  }
  return undefined
}

describe("checkSendsPerHour", () => {
  test("no limit counts nothing", () => {
    expect(refusal(ledgerOf([1, "unknown"], [2, "confirmed"]), undefined)).toBeUndefined()
  })

  test("below the limit passes", () => {
    expect(refusal(ledgerOf([1, "unknown"], [2, "confirmed"]), 3)).toBeUndefined()
  })

  test("at the limit is rate_limited, naming the limit and the setting, and says when the oldest row leaves", () => {
    const error = refusal(ledgerOf([10, "confirmed"], [50, "pending"], [20, "failed"]), 3)
    expect(isToolError(error) && error.code).toBe("rate_limited")
    expect(isToolError(error) && error.details).toEqual({ retry_after_s: 10 * 60 })
    expect(error).toMatchObject({ message: expect.stringMatching(/sends_per_hour.*limit of 3/) })
  })

  test("past the limit waits for enough rows to leave, not only the oldest", () => {
    const error = refusal(ledgerOf([50, "unknown"], [40, "unknown"], [30, "unknown"], [20, "unknown"]), 2)
    expect(isToolError(error) && error.details).toEqual({ retry_after_s: 30 * 60 })
  })

  test("rejected rows do not count", () => {
    expect(refusal(ledgerOf([1, "rejected"], [2, "rejected"], [3, "confirmed"]), 2)).toBeUndefined()
  })

  test("rows older than 60 minutes do not count, and one exactly 60 minutes old still does", () => {
    expect(refusal(ledgerOf([61, "confirmed"], [90, "failed"], [5, "confirmed"]), 2)).toBeUndefined()
    const error = refusal(ledgerOf([60, "confirmed"]), 1)
    expect(isToolError(error) && error.details).toEqual({ retry_after_s: 1 })
  })

  test("the wait is at least a second and rounds up", () => {
    const error = refusal(ledgerOf([59.999, "confirmed"]), 1)
    expect(isToolError(error) && error.details).toEqual({ retry_after_s: 1 })
    expect(refusal(ledgerOf([0, "confirmed"]), 1, NOW + 500)).toMatchObject({ details: { retry_after_s: 3600 } })
  })
})

describe("sendsPerHour", () => {
  const context = (options?: ToolContext["options"]): ToolContext => ({ cwd: "/", options })

  test("is absent when the option is not given", () => {
    expect(sendsPerHour(context())).toBeUndefined()
    expect(sendsPerHour(context({}))).toBeUndefined()
  })

  test("is the option when it is a whole number from 1", () => {
    expect(sendsPerHour(context({ sends_per_hour: 5 }))).toBe(5)
  })

  test.each([0, 1.5, -1, "5", true])("is internal_error for %p, which parsing never lets through", (value) => {
    try {
      sendsPerHour(context({ sends_per_hour: value }))
      throw new Error("not refused")
    } catch (error) {
      expect(isToolError(error) && error.code).toBe("internal_error")
    }
  })
})
