import { ToolError } from "./errors"
import { MAX_UINT256 } from "./evm/uint256"

/** An integer part without leading zeros (`0` alone is fine), then optionally a `.` and at least one digit. */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/

/** A whole number of smallest units, without leading zeros. */
const UNITS_PATTERN = /^(?:0|[1-9]\d*)$/

/** No amount in digits is longer: 78 digits of a 2^256 value, a point and the most decimals a token has. */
const MAX_TEXT_LENGTH = 120

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

function isDecimalText(text: string, pattern: RegExp): boolean {
  return typeof text === "string" && text.length <= MAX_TEXT_LENGTH && pattern.test(text)
}

/**
 * The smallest units of `text`, an amount written as a decimal string such as `1` or `0.5`: digits and at most one
 * `.` with digits on both sides, so `.5`, `1.`, a sign, an exponent and spaces are refused, as are leading zeros
 * (`007`; `0.5` is fine). It must be more than 0 and have at most `decimals` fractional digits: a more precise
 * amount is refused, never rounded. A failure is `invalid_argument` naming `name`.
 */
export function parseAmount(text: string, decimals: number, name = "amount"): bigint {
  const match = isDecimalText(text, AMOUNT_PATTERN) ? AMOUNT_PATTERN.exec(text) : null
  if (!match) {
    throw invalid(`The ${name} must be a decimal number in digits, such as 1 or 0.5, with no sign or exponent.`)
  }
  const [, whole, fraction = ""] = match
  if (fraction.length > decimals) {
    throw invalid(
      `The ${name} has more decimal places than the token: it has ${decimals} decimals, and amounts are never rounded.`,
    )
  }
  const units = BigInt(whole + fraction.padEnd(decimals, "0"))
  if (units === 0n) throw invalid(`The ${name} must be more than 0.`)
  if (units > MAX_UINT256) throw invalid(`The ${name} is larger than 2^256 - 1 smallest units.`)
  return units
}

/** `units` as a decimal string with `decimals` fractional digits, exact and without trailing fractional zeros. */
export function formatAmount(units: bigint, decimals: number): string {
  const sign = units < 0n ? "-" : ""
  const digits = (units < 0n ? -units : units).toString().padStart(decimals + 1, "0")
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "")
  return `${sign}${whole}${fraction === "" ? "" : `.${fraction}`}`
}

/**
 * `text` as a whole number of smallest units (wei, lamports), such as a `max_fee`: digits only, from 0, without
 * leading zeros (`0` alone is fine) and at most 2^256 - 1. A failure is `invalid_argument` naming `name`.
 */
export function parseUnits(text: string, name: string): bigint {
  if (!isDecimalText(text, UNITS_PATTERN)) {
    throw invalid(`The ${name} must be a whole number of digits only, without a sign, a point or leading zeros.`)
  }
  const units = BigInt(text)
  if (units > MAX_UINT256) throw invalid(`The ${name} is larger than 2^256 - 1.`)
  return units
}
