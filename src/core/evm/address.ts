import { hexToBytes } from "@noble/curves/utils.js"
import { ToolError } from "../errors"
import { toChecksumAddress } from "../signer/derive"

/** `0x` and 40 hex digits, in any case. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

/** The longest text an error quotes back; a longer one is reported by its length. */
const MAX_QUOTED_LENGTH = 66

function invalid(text: string, problem: string): ToolError {
  const subject = text.length > MAX_QUOTED_LENGTH ? `(${text.length} characters)` : `"${text}"`
  return new ToolError("invalid_argument", `The EVM address ${subject} ${problem}`)
}

/**
 * The EIP-55 form of the EVM address `text`: `0x` and 40 hex digits. All lower
 * or all upper case is taken as it is; mixed case must be the address's own
 * EIP-55 capitals, since a mistyped digit then fails the check.
 */
export function parseEvmAddress(text: string): string {
  if (!ADDRESS_PATTERN.test(text)) throw invalid(text, "is not 0x followed by 40 hex digits.")
  const checksummed = toChecksumAddress(hexToBytes(text.slice(2)))
  const digits = text.slice(2)
  const mixedCase = digits !== digits.toLowerCase() && digits !== digits.toUpperCase()
  if (mixedCase && text !== checksummed) throw invalid(text, "has capitals that do not match its EIP-55 checksum.")
  return checksummed
}
