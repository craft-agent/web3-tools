import { describe, expect, test } from "bun:test"
import { abiString, bytesArgument, bytesOfHex, decodeAbiString, readWord, word } from "./abi"
import { selectorOf } from "./testing.contracts"
import {
  balanceOfCall,
  DECIMALS_CALL,
  getL1FeeCall,
  getOperatorFeeCall,
  SYMBOL_CALL,
  TOKEN_RATIO_CALL,
  VIEW_SELECTORS,
} from "./views"

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

describe("the selectors of the reads", () => {
  test.each([
    ["decimals()", VIEW_SELECTORS.decimals],
    ["symbol()", VIEW_SELECTORS.symbol],
    ["balanceOf(address)", VIEW_SELECTORS.balanceOf],
    ["getL1Fee(bytes)", VIEW_SELECTORS.getL1Fee],
    ["getOperatorFee(uint256)", VIEW_SELECTORS.getOperatorFee],
    ["tokenRatio()", VIEW_SELECTORS.tokenRatio],
  ])("%s is the first four bytes of its Keccak-256", (signature, selector) => {
    expect(selector).toBe(selectorOf(signature))
  })
})

describe("the calldata of the reads", () => {
  test("calls without arguments are their selector", () => {
    expect([DECIMALS_CALL, SYMBOL_CALL, TOKEN_RATIO_CALL]).toEqual(["0x313ce567", "0x95d89b41", "0x06f837d3"])
  })

  test("balanceOf pads the owner to a word", () => {
    expect(balanceOfCall(OWNER)).toBe(`0x70a08231${"0".repeat(24)}${OWNER.slice(2).toLowerCase()}`)
  })

  test("getOperatorFee takes the gas limit as a word", () => {
    expect(getOperatorFeeCall(60_000n)).toBe(`0x275aedd2${word(60_000n)}`)
  })

  test("getL1Fee lays out the offset, the length and the data padded to whole words", () => {
    const transaction = `0x02${"ab".repeat(40)}`
    const call = getL1FeeCall(transaction)
    const bytes = bytesOfHex(call)!
    expect(call.startsWith(`0x${VIEW_SELECTORS.getL1Fee}`)).toBe(true)
    expect(readWord(bytes.subarray(4), 0)).toBe(32n)
    expect(readWord(bytes.subarray(4), 1)).toBe(41n)
    expect((bytes.length - 4) % 32).toBe(0)
    expect(bytes.length).toBe(4 + 32 * 2 + 64)
    expect(call.slice(2 + 8 + 128, 2 + 8 + 128 + 82)).toBe(transaction.slice(2))
    expect(call.slice(2 + 8 + 128 + 82)).toBe("0".repeat(128 - 82))
  })

  test("getL1Fee of whole words adds no padding, and of nothing is an empty bytes", () => {
    expect(getL1FeeCall(`0x${"cd".repeat(32)}`)).toBe(`0x49948e0e${word(32n)}${word(32n)}${"cd".repeat(32)}`)
    expect(getL1FeeCall("0x")).toBe(`0x49948e0e${word(32n)}${word(0n)}`)
  })

  test("data that is not hex is refused", () => {
    expect(() => bytesArgument("0xzz")).toThrow()
  })
})

describe("ABI strings", () => {
  test("round trip through abiString and decodeAbiString", () => {
    for (const text of ["USDC", "", "日本円", "x".repeat(70)]) {
      expect(decodeAbiString(bytesOfHex(abiString(text))!)).toBe(text)
    }
  })

  test("what is not a string reads as undefined", () => {
    expect(decodeAbiString(new Uint8Array(10))).toBeUndefined()
    const lying = bytesOfHex(`0x${word(32n)}${word(500n)}${"00".repeat(32)}`)!
    expect(decodeAbiString(lying)).toBeUndefined()
    const farOffset = bytesOfHex(`0x${word(4000n)}${word(1n)}${"00".repeat(32)}`)!
    expect(decodeAbiString(farOffset)).toBeUndefined()
    const notUtf8 = bytesOfHex(`0x${word(32n)}${word(1n)}ff${"00".repeat(31)}`)!
    expect(decodeAbiString(notUtf8)).toBeUndefined()
  })
})
