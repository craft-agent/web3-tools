import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { parseEvmAddress } from "./address"
import { checkUint256, MAX_UINT256 } from "./uint256"

const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"

function refusal(work: () => unknown): { code: string; message: string } {
  try {
    work()
  } catch (error) {
    if (isToolError(error)) return { code: error.code, message: error.message }
  }
  throw new Error("expected a refusal")
}

describe("parseEvmAddress", () => {
  test("gives the EIP-55 form of an all lower case or all upper case address", () => {
    expect(parseEvmAddress(CHECKSUMMED.toLowerCase())).toBe(CHECKSUMMED)
    expect(parseEvmAddress(`0x${CHECKSUMMED.slice(2).toUpperCase()}`)).toBe(CHECKSUMMED)
  })

  test("accepts a mixed case address with the right checksum", () => {
    expect(parseEvmAddress(CHECKSUMMED)).toBe(CHECKSUMMED)
  })

  test("refuses a mixed case address whose checksum is wrong, as invalid_argument", () => {
    const wrong = CHECKSUMMED.replace("aAe", "aae")
    expect(wrong).not.toBe(CHECKSUMMED)
    const { code, message } = refusal(() => parseEvmAddress(wrong))
    expect(code).toBe("invalid_argument")
    expect(message).toContain("EIP-55")
    expect(message).toContain(wrong)
  })

  test.each([
    "",
    "0x",
    "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    `${CHECKSUMMED}0`,
    `0x${"g".repeat(40)}`,
    "vitalik.eth",
  ])("refuses %p as not 0x and 40 hex digits", (text) => {
    const { code, message } = refusal(() => parseEvmAddress(text))
    expect(code).toBe("invalid_argument")
    expect(message).toContain("40 hex digits")
  })

  test("reports a long text by its length instead of quoting it", () => {
    const text = `0x${"a".repeat(500)}`
    const { message } = refusal(() => parseEvmAddress(text))
    expect(message).toContain("(502 characters)")
    expect(message).not.toContain("aaaa")
  })
})

describe("checkUint256", () => {
  test("accepts the ends of the range", () => {
    expect(checkUint256(0n, "amount")).toBe(0n)
    expect(checkUint256(MAX_UINT256, "amount")).toBe(MAX_UINT256)
  })

  test.each([-1n, MAX_UINT256 + 1n, 1 as unknown as bigint])("refuses %p, naming the value's role", (value) => {
    const { code, message } = refusal(() => checkUint256(value, "amount"))
    expect(code).toBe("invalid_argument")
    expect(message).toContain("amount")
  })
})
