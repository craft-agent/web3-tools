import { describe, expect, test } from "bun:test"
import { formatAmount, parseAmount, parseUnits } from "./amount"
import { isToolError } from "./errors"
import { MAX_UINT256 } from "./evm/uint256"

function refusal(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (isToolError(error) && error.code === "invalid_argument") return error.message
  }
  throw new Error("expected an invalid_argument refusal")
}

describe("parseAmount", () => {
  test("takes whole and fractional amounts in the token's units", () => {
    expect(parseAmount("1", 18)).toBe(10n ** 18n)
    expect(parseAmount("0.5", 18)).toBe(5n * 10n ** 17n)
    expect(parseAmount("1.25", 6)).toBe(1_250_000n)
    expect(parseAmount("0.000001", 6)).toBe(1n)
    expect(parseAmount("12", 0)).toBe(12n)
    expect(parseAmount("1.100", 6)).toBe(1_100_000n)
  })

  test("refuses more decimals than the token has, saying so and that nothing is rounded", () => {
    const message = refusal(() => parseAmount("0.0000001", 6, "amount"))
    expect(message).toContain("6 decimals")
    expect(message).toContain("never rounded")
    expect(refusal(() => parseAmount("1.5", 0))).toContain("0 decimals")
  })

  test("refuses every form but digits with one inner point", () => {
    for (const text of [
      ".5",
      "1.",
      ".",
      "",
      " 1",
      "1 ",
      "+1",
      "-1",
      "1e3",
      "1E3",
      "0x10",
      "1,5",
      "1.2.3",
      "１",
      "007",
      "00.5",
    ]) {
      expect(refusal(() => parseAmount(text, 18))).toContain("decimal number")
    }
  })

  test("refuses zero, however it is written, and a value past 2^256 - 1", () => {
    for (const text of ["0", "0.0", "0.000"]) {
      expect(refusal(() => parseAmount(text, 6))).toContain("more than 0")
    }
    expect(parseAmount(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256)
    expect(refusal(() => parseAmount((MAX_UINT256 + 1n).toString(), 0))).toContain("larger")
    expect(refusal(() => parseAmount("9".repeat(500), 0))).toContain("decimal number")
  })

  test("names the argument it refuses", () => {
    expect(refusal(() => parseAmount("x", 6, "fee"))).toContain("The fee ")
    expect(refusal(() => parseAmount("x", 6))).toContain("The amount ")
  })
})

describe("formatAmount", () => {
  test("writes the exact decimal without trailing fractional zeros", () => {
    expect(formatAmount(10n ** 18n, 18)).toBe("1")
    expect(formatAmount(5n * 10n ** 17n, 18)).toBe("0.5")
    expect(formatAmount(1n, 6)).toBe("0.000001")
    expect(formatAmount(1_100_000n, 6)).toBe("1.1")
    expect(formatAmount(0n, 6)).toBe("0")
    expect(formatAmount(12n, 0)).toBe("12")
    expect(formatAmount(MAX_UINT256, 18)).toBe(
      "115792089237316195423570985008687907853269984665640564039457.584007913129639935",
    )
  })

  test("parses back to what it was given", () => {
    for (const [units, decimals] of [
      [1n, 18],
      [123_456_789n, 6],
      [10n ** 30n, 9],
      [7n, 0],
      [MAX_UINT256, 36],
    ] as const) {
      expect(parseAmount(formatAmount(units, decimals), decimals)).toBe(units)
    }
  })
})

describe("parseUnits", () => {
  test("takes whole numbers of digits, from 0", () => {
    expect(parseUnits("0", "max_fee")).toBe(0n)
    expect(parseUnits("1000000000", "max_fee")).toBe(10n ** 9n)
    expect(parseUnits(MAX_UINT256.toString(), "max_fee")).toBe(MAX_UINT256)
  })

  test("refuses signs, points, exponents, spaces, leading zeros, hex and empty text", () => {
    for (const text of ["", "-1", "+1", "1.0", "1e9", " 1", "1 ", "01", "00", "0x1", "1_000"]) {
      expect(refusal(() => parseUnits(text, "max_fee"))).toContain("The max_fee ")
    }
  })

  test("refuses a value past 2^256 - 1", () => {
    expect(refusal(() => parseUnits((MAX_UINT256 + 1n).toString(), "max_fee"))).toContain("larger")
  })
})
