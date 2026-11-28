import { ToolError } from "../errors"

/** The largest value of an EVM word. */
export const MAX_UINT256 = 2n ** 256n - 1n

/** `value` when it is a bigint from 0 to 2^256 - 1; else `invalid_argument` naming `name`. */
export function checkUint256(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    throw new ToolError("invalid_argument", `The ${name} must be a whole number from 0 to 2^256 - 1.`)
  }
  return value
}
