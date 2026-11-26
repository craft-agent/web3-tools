import { describe, expect, test } from "bun:test"
import { ToolError, isAbortError } from "../errors"
import { NEVER, baseClient, clientsFor, rejection, stallingBody, toolError } from "./client.fixtures"

const SHORT_TIMEOUT_MS = 20
const PARTIAL_REPLY = '{"jsonrpc":"2.0","id":1,"res'

describe("JsonRpcClient cancellation", () => {
  test("the caller's abort during the call rejects with an AbortError, not a ToolError", async () => {
    const controller = new AbortController()
    const { client } = baseClient({ m: NEVER }, { signal: controller.signal })
    const pending = rejection(client.call("m"))
    controller.abort()
    const error = await pending

    expect(error).not.toBeInstanceOf(ToolError)
    expect(isAbortError(error)).toBe(true)
  })

  test("a signal that was aborted already rejects with an AbortError and sends nothing", async () => {
    const { client, requests } = baseClient({ m: { result: 1 } }, { signal: AbortSignal.abort() })
    const error = await rejection(client.call("m"))

    expect(error).not.toBeInstanceOf(ToolError)
    expect(isAbortError(error)).toBe(true)
    expect(requests).toHaveLength(0)
  })

  test("the caller's abort while the body streams is an AbortError", async () => {
    const controller = new AbortController()
    const { base } = clientsFor(
      () => Promise.resolve(new Response(stallingBody(PARTIAL_REPLY))),
      {},
      {
        signal: controller.signal,
      },
    )
    const pending = rejection(base.call("m"))
    setTimeout(() => controller.abort(), SHORT_TIMEOUT_MS)
    const error = await pending

    expect(error).not.toBeInstanceOf(ToolError)
    expect(isAbortError(error)).toBe(true)
  })
})

describe("JsonRpcClient time limit", () => {
  test("a reply that never comes ends in upstream_error after the time limit", async () => {
    const { client } = baseClient({ m: NEVER }, { timeoutMs: SHORT_TIMEOUT_MS })
    const error = await toolError(client.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) did not answer within 0.02 s.")
  })

  test("the limit also covers a body that stops streaming", async () => {
    const { base } = clientsFor(
      () => Promise.resolve(new Response(stallingBody(PARTIAL_REPLY))),
      {},
      {
        timeoutMs: SHORT_TIMEOUT_MS,
      },
    )
    const error = await toolError(base.call("m"))

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("Base (public endpoint) did not answer within 0.02 s.")
  })

  test("a call that answers in time is not cut by a timer left running", async () => {
    const { client } = baseClient({ m: { result: "ok" } }, { timeoutMs: SHORT_TIMEOUT_MS })

    expect(await client.call("m")).toBe("ok")
    await new Promise((resolve) => setTimeout(resolve, SHORT_TIMEOUT_MS * 2))
    expect(await client.call("m")).toBe("ok")
  })
})
