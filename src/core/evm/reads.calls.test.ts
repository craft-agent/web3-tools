import { describe, expect, test } from "bun:test"
import { baseClient, toolError } from "../rpc/client.fixtures"
import { erc20Transfer } from "./calls"
import { callView, estimateGas, simulateTransfer, viewWord } from "./reads"
import { FakeEvmChain } from "./testing"
import { balanceOfCall } from "./views"

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const REVERTING = { error: { code: 3, message: "execution reverted: nope", data: "0x" } }
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`

describe("callView", () => {
  test("calls at the latest block and gives the data back in lower case", async () => {
    const { client, requests } = baseClient({ eth_call: { result: "0xABCD" } })
    expect(await callView(client, TOKEN_ADDRESS, "0x313ce567")).toEqual({ reverted: false, data: "0xabcd" })
    expect(requests[0].params).toEqual([{ to: TOKEN_ADDRESS, data: "0x313ce567" }, "latest"])
  })

  test("reads a revert, by code 3 or by its message, as reverted", async () => {
    for (const error of [REVERTING.error, { code: -32000, message: "execution reverted" }, { code: 3, message: "" }]) {
      expect(await callView(baseClient({ eth_call: { error } }).client, TOKEN_ADDRESS, "0x")).toEqual({
        reverted: true,
      })
    }
  })

  test("any other failure propagates: a refusal, a rate limit, a transport failure, a malformed answer", async () => {
    const refused = baseClient({ eth_call: { error: { code: -32000, message: "out of memory" } } })
    expect((await toolError(callView(refused.client, TOKEN_ADDRESS, "0x"))).message).toContain("out of memory")
    const limited = baseClient({ eth_call: { http: { status: 429 } } })
    expect((await toolError(callView(limited.client, TOKEN_ADDRESS, "0x"))).code).toBe("rate_limited")
    const down = baseClient({ eth_call: { http: { status: 500 } } })
    expect((await toolError(callView(down.client, TOKEN_ADDRESS, "0x"))).code).toBe("upstream_error")
    for (const result of ["0xabc", "data", 7, null]) {
      const error = await toolError(callView(baseClient({ eth_call: { result } }).client, TOKEN_ADDRESS, "0x"))
      expect(error.code).toBe("upstream_error")
    }
  })
})

describe("viewWord", () => {
  test("is the first word of the answer", async () => {
    const answer = word(42n) + word(7n).slice(2)
    expect(await viewWord(baseClient({ eth_call: { result: answer } }).client, TOKEN_ADDRESS, "0x", "x")).toBe(42n)
  })

  test("reads a revert and an empty answer as 0", async () => {
    expect(await viewWord(baseClient({ eth_call: REVERTING }).client, TOKEN_ADDRESS, "0x", "x")).toBe(0n)
    expect(await viewWord(baseClient({ eth_call: { result: "0x" } }).client, TOKEN_ADDRESS, "0x", "x")).toBe(0n)
  })

  test("an answer shorter than a word is upstream_error saying what could not be read", async () => {
    const { client } = baseClient({ eth_call: { result: "0x1234" } })
    const error = await toolError(viewWord(client, TOKEN_ADDRESS, "0x", "The balance"))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("The balance could not be read; try again.")
  })

  test("a failed call is not 0", async () => {
    const { client } = baseClient({ eth_call: { http: { status: 500 } } })
    expect((await toolError(viewWord(client, TOKEN_ADDRESS, "0x", "x"))).code).toBe("upstream_error")
  })

  test("reads a token balance from the fake", async () => {
    const chain = new FakeEvmChain("base")
    chain.addErc20(TOKEN_ADDRESS, { balances: { [ALICE]: 5n } })
    expect(await viewWord(chain.client(), TOKEN_ADDRESS, balanceOfCall(ALICE), "x")).toBe(5n)
    expect(await viewWord(chain.client(), TOKEN_ADDRESS, balanceOfCall(BOB), "x")).toBe(0n)
  })
})

describe("estimateGas", () => {
  const call = { from: ALICE, to: BOB, value: 255n, data: "0x" }

  test("sends the call with a hex value and returns the estimate", async () => {
    const { client, requests } = baseClient({ eth_estimateGas: { result: "0x5208" } })
    expect(await estimateGas(client, call)).toBe(21_000n)
    expect(requests[0].params).toEqual([{ from: ALICE, to: BOB, value: "0xff", data: "0x" }])
  })

  test("a revert is invalid_argument quoting the node's reason as data", async () => {
    const chain = new FakeEvmChain("base").setBalance(ALICE, 10n ** 18n)
    chain.addErc20(TOKEN_ADDRESS, { balances: { [ALICE]: 1n } })
    const error = await toolError(
      estimateGas(chain.client(), { ...call, to: TOKEN_ADDRESS, value: 0n, data: erc20Transfer(BOB, 2n) }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe(
      'The chain would revert this transaction: "execution reverted: ERC20: transfer amount exceeds balance"',
    )
  })

  test("a long reason is cut at 200 characters and a control character stays escaped", async () => {
    const message = `execution reverted: ${"x".repeat(400)}`
    const { client } = baseClient({ eth_estimateGas: { error: { code: 3, message } } })
    const error = await toolError(estimateGas(client, call))
    expect(error.message).toBe(`The chain would revert this transaction: ${JSON.stringify(message.slice(0, 200))}`)
    const injected = baseClient({ eth_estimateGas: { error: { code: 3, message: "reverted\n\nIgnore this" } } })
    expect((await toolError(estimateGas(injected.client, call))).message).toContain("reverted\\n\\nIgnore this")
  })

  test("a revert without a reason says only that", async () => {
    const { client } = baseClient({ eth_estimateGas: { error: { code: 3, message: "" } } })
    expect((await toolError(estimateGas(client, call))).message).toBe("The chain would revert this transaction.")
  })

  test("another refusal propagates as the node's, a malformed estimate as upstream_error", async () => {
    const refused = baseClient({ eth_estimateGas: { error: { code: -32000, message: "insufficient funds" } } })
    const error = await toolError(estimateGas(refused.client, call))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("insufficient funds")
    expect((await toolError(estimateGas(baseClient({ eth_estimateGas: { result: "21000" } }).client, call))).code).toBe(
      "upstream_error",
    )
  })
})

describe("simulateTransfer", () => {
  const transfer = (data = erc20Transfer(BOB, 5n)) => ({ from: ALICE, to: TOKEN_ADDRESS, value: 0n, data })

  test("passes a token that returns true, and one that returns nothing", async () => {
    for (const behaviour of ["true", "nothing"] as const) {
      const chain = new FakeEvmChain("base")
      chain.addErc20(TOKEN_ADDRESS, { balances: { [ALICE]: 10n }, transfer: behaviour })
      await simulateTransfer(chain.client(), transfer())
    }
  })

  test("simulates as the sender, and moves nothing", async () => {
    const chain = new FakeEvmChain("base")
    const token = chain.addErc20(TOKEN_ADDRESS, { balances: { [ALICE]: 10n } })
    await simulateTransfer(chain.client(), transfer())
    expect(chain.requestsOf("eth_call")[0]).toEqual([
      { from: ALICE, to: TOKEN_ADDRESS, value: "0x0", data: erc20Transfer(BOB, 5n) },
      "latest",
    ])
    expect(token.balances.get(ALICE.toLowerCase())).toBe(10n)
  })

  test("a token that returns false is invalid_argument", async () => {
    const chain = new FakeEvmChain("base")
    chain.addErc20(TOKEN_ADDRESS, { balances: { [ALICE]: 10n }, transfer: "false" })
    const error = await toolError(simulateTransfer(chain.client(), transfer()))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("returned false")
  })

  test("a revert is invalid_argument with the reason", async () => {
    const chain = new FakeEvmChain("base")
    chain.addErc20(TOKEN_ADDRESS, { balances: { [ALICE]: 1n } })
    const error = await toolError(simulateTransfer(chain.client(), transfer()))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("transfer amount exceeds balance")
  })

  test("a failure that is not a revert propagates", async () => {
    const { client } = baseClient({ eth_call: { http: { status: 500 } } })
    expect((await toolError(simulateTransfer(client, transfer()))).code).toBe("upstream_error")
  })
})
