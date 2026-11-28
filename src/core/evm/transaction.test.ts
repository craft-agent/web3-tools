import { describe, expect, test } from "bun:test"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { Transaction } from "micro-eth-signer"
import { isToolError } from "../errors"
import { MAX_UINT256 } from "./uint256"
import { placeholderSignedEvmTransactionHex, unsignedEvmTransactionHex } from "./transaction"
import type { EvmTransactionRequest } from "./transaction"

const GWEI = 10n ** 9n

const REQUEST: EvmTransactionRequest = {
  chainId: 8453,
  to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  value: 10n ** 18n,
  data: "0xa9059cbb",
  nonce: 7n,
  gasLimit: 60_000n,
  maxFeePerGas: 20n * GWEI,
  maxPriorityFeePerGas: GWEI,
}

function refusal(request: EvmTransactionRequest): string {
  try {
    unsignedEvmTransactionHex(request)
  } catch (error) {
    if (isToolError(error) && error.code === "invalid_argument") return error.message
  }
  throw new Error("expected an invalid_argument refusal")
}

describe("unsignedEvmTransactionHex", () => {
  test("is the unsigned type 2 serialization, which gives every field back", () => {
    const hex = unsignedEvmTransactionHex(REQUEST)
    expect(hex).toMatch(/^0x02[0-9a-f]+$/)
    const { raw, isSigned, type } = Transaction.fromHex(hex)
    expect(type).toBe("eip1559")
    expect(isSigned).toBe(false)
    expect(raw).toMatchObject({
      chainId: 8453n,
      to: REQUEST.to,
      value: REQUEST.value,
      data: REQUEST.data,
      nonce: REQUEST.nonce,
      gasLimit: REQUEST.gasLimit,
      maxFeePerGas: REQUEST.maxFeePerGas,
      maxPriorityFeePerGas: REQUEST.maxPriorityFeePerGas,
      accessList: [],
    })
  })

  test("takes the recipient in any case and writes it by its checksum", () => {
    const lower = unsignedEvmTransactionHex({ ...REQUEST, to: REQUEST.to.toLowerCase() })
    expect(lower).toBe(unsignedEvmTransactionHex(REQUEST))
  })
})

describe("placeholderSignedEvmTransactionHex", () => {
  test("is the request signed with r and s at the curve's order less one", () => {
    const largest = secp256k1.Point.Fn.ORDER - 1n
    const { raw, isSigned } = Transaction.fromHex(placeholderSignedEvmTransactionHex(REQUEST))
    expect(isSigned).toBe(true)
    expect(raw).toMatchObject({ r: largest, s: largest, yParity: 1, nonce: REQUEST.nonce, data: REQUEST.data })
  })

  test("is the unsigned serialization with the signature added", () => {
    const unsigned = unsignedEvmTransactionHex(REQUEST)
    const placeholder = placeholderSignedEvmTransactionHex(REQUEST)
    expect(placeholder.length).toBeGreaterThan(unsigned.length)
  })

  test("refuses what the unsigned one refuses", () => {
    expect(() => placeholderSignedEvmTransactionHex({ ...REQUEST, gasLimit: 1n })).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    )
  })
})

describe("a request that cannot be signed is invalid_argument", () => {
  test.each([0, -1, 1.5, Number.NaN, 2 ** 53])("a chain id of %p", (chainId) => {
    expect(refusal({ ...REQUEST, chainId })).toContain("chain id")
  })

  test.each(["", "vitalik.eth", "0x1234", REQUEST.to.replace("C518", "c518")])("a recipient of %p", (to) => {
    expect(refusal({ ...REQUEST, to })).toContain("EVM address")
  })

  test.each(["", "00", "0x1", "0xzz", "0x123"])("data of %p", (data) => {
    expect(refusal({ ...REQUEST, data })).toContain("hex digits")
  })

  test.each([
    ["value", { value: -1n }],
    ["value", { value: MAX_UINT256 + 1n }],
    ["nonce", { nonce: -1n }],
    ["gas limit", { gasLimit: MAX_UINT256 + 1n }],
    ["max fee per gas", { maxFeePerGas: -1n }],
    ["max priority fee per gas", { maxPriorityFeePerGas: MAX_UINT256 + 1n }],
  ])("a %s out of the range of a word", (name, change) => {
    expect(refusal({ ...REQUEST, ...change })).toContain(name)
  })

  test("a gas limit under 21000", () => {
    expect(refusal({ ...REQUEST, gasLimit: 20_999n })).toContain("gas limit")
  })

  test("a priority fee above the max fee", () => {
    expect(refusal({ ...REQUEST, maxPriorityFeePerGas: REQUEST.maxFeePerGas + 1n })).toContain("priority fee")
  })
})

describe("the library's strict limits are left to the chain", () => {
  test.each([
    ["a nonce over 131072", { nonce: 131_073n }],
    ["a fee over 10000 gwei", { maxFeePerGas: 10_001n * GWEI }],
    ["a value of a million coins", { value: 1_000_000n * 10n ** 18n }],
    ["a gas limit over 30 million", { gasLimit: 30_000_001n }],
  ])("%s is built", (_, change) => {
    const request = { ...REQUEST, ...change }
    expect(Transaction.fromHex(unsignedEvmTransactionHex(request)).raw).toMatchObject(change)
  })
})
