import { describe, expect, test } from "bun:test"
import { ed25519 } from "@noble/curves/ed25519.js"
import { base58 } from "@scure/base"
import { isToolError } from "../errors"
import { parseKey } from "./keys"
import { ABANDON_PHRASE, HARDHAT_KEY_0, HARDHAT_PHRASE, SOLANA_KEYPAIR_BASE58, SOLANA_KEYPAIR_JSON } from "./testing"

const LABEL = "main"
const CURVE_ORDER = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
const PHRASE_RULE = "a BIP-39 phrase has 12, 15, 18, 21 or 24."
const UNKNOWN_FORM = `The key of wallet "${LABEL}" is not a seed phrase, an EVM private key or a Solana keypair.`

function mismatchedKeypair(): Uint8Array {
  const seed = new Uint8Array(32).fill(7)
  return new Uint8Array([...seed, ...ed25519.getPublicKey(new Uint8Array(32).fill(8))])
}

const refusals: { name: string; text: string; message: string }[] = [
  { name: "empty text", text: "", message: `The key of wallet "${LABEL}" is empty.` },
  { name: "blank text", text: " \n\t ", message: `The key of wallet "${LABEL}" is empty.` },
  { name: "a short JSON array", text: "[1,2,3]", message: UNKNOWN_FORM },
  { name: "JSON that does not parse", text: "[secretword, 12", message: UNKNOWN_FORM },
  { name: "a JSON object", text: '[{"zzz":"secretword"}]', message: UNKNOWN_FORM },
  { name: "an array of 65 numbers", text: JSON.stringify(Array(65).fill(7)), message: UNKNOWN_FORM },
  { name: "a number above 255", text: JSON.stringify(Array(64).fill(256)), message: UNKNOWN_FORM },
  { name: "a negative number", text: JSON.stringify(Array(64).fill(-1)), message: UNKNOWN_FORM },
  { name: "a fractional number", text: JSON.stringify(Array(64).fill(7.5)), message: UNKNOWN_FORM },
  { name: "a number as a string", text: JSON.stringify(Array(64).fill("7")), message: UNKNOWN_FORM },
  {
    name: "a JSON keypair with a wrong public half",
    text: JSON.stringify([...mismatchedKeypair()]),
    message: `The key of wallet "${LABEL}" is a Solana keypair whose public half does not match its secret.`,
  },
  {
    name: "a base58 keypair with a wrong public half",
    text: base58.encode(mismatchedKeypair()),
    message: `The key of wallet "${LABEL}" is a Solana keypair whose public half does not match its secret.`,
  },
  {
    name: "an EVM key of zero",
    text: `0x${"0".repeat(64)}`,
    message: `The key of wallet "${LABEL}" is not a valid EVM private key.`,
  },
  {
    name: "an EVM key at the curve order",
    text: CURVE_ORDER,
    message: `The key of wallet "${LABEL}" is not a valid EVM private key.`,
  },
  {
    name: "an EVM key above the curve order",
    text: `0x${"f".repeat(64)}`,
    message: `The key of wallet "${LABEL}" is not a valid EVM private key.`,
  },
  { name: "63 hex digits", text: HARDHAT_KEY_0.slice(3), message: UNKNOWN_FORM },
  { name: "65 hex digits", text: `${HARDHAT_KEY_0}a`, message: UNKNOWN_FORM },
  { name: "an upper-case 0X prefix", text: `0X${HARDHAT_KEY_0.slice(2)}`, message: UNKNOWN_FORM },
  {
    name: "hex digits split by a space",
    text: `${HARDHAT_KEY_0.slice(2, 34)} ${HARDHAT_KEY_0.slice(34)}`,
    message: `The key of wallet "${LABEL}" is a phrase of 2 words; ${PHRASE_RULE}`,
  },
  {
    name: "a phrase of 11 words",
    text: HARDHAT_PHRASE.split(" ").slice(1).join(" "),
    message: `The key of wallet "${LABEL}" is a phrase of 11 words; ${PHRASE_RULE}`,
  },
  {
    name: "a phrase of 13 words",
    text: `${HARDHAT_PHRASE} junk`,
    message: `The key of wallet "${LABEL}" is a phrase of 13 words; ${PHRASE_RULE}`,
  },
  {
    name: "a phrase whose checksum fails",
    text: Array(12).fill("test").join(" "),
    message: `The key of wallet "${LABEL}" is not a valid BIP-39 phrase: a word is not in the English list or its checksum does not match.`,
  },
  {
    name: "a phrase with a word outside the list",
    text: ABANDON_PHRASE.replace("about", "zzzzzzzz"),
    message: `The key of wallet "${LABEL}" is not a valid BIP-39 phrase: a word is not in the English list or its checksum does not match.`,
  },
  { name: "a single word", text: "hunter2secret", message: UNKNOWN_FORM },
  { name: "base58 of the wrong length", text: SOLANA_KEYPAIR_BASE58.slice(0, 60), message: UNKNOWN_FORM },
  { name: "base58 of 63 bytes", text: base58.encode(new Uint8Array(63).fill(9)), message: UNKNOWN_FORM },
  { name: "characters outside base58", text: SOLANA_KEYPAIR_BASE58.replace(/^./, "0"), message: UNKNOWN_FORM },
]

/** The pieces of `text` that must never reach an error: the whole text and each word, number or digit run of it. */
function secrets(text: string): string[] {
  const parts = text.split(/[\s,[\]{}":]+/).filter((part) => part.length >= 3)
  return [text.trim(), ...parts].filter((part) => part !== "")
}

function refusal(text: string): Error {
  try {
    parseKey(text, LABEL)
  } catch (error) {
    return error as Error
  }
  throw new Error("parseKey did not refuse")
}

describe("parseKey refusals", () => {
  for (const { name, text, message } of refusals) {
    test(`${name} is unauthenticated, names the label and quotes nothing of the text`, () => {
      const error = refusal(text)
      expect(isToolError(error) && error.code).toBe("unauthenticated")
      expect(error.message).toBe(message)
      expect("cause" in error).toBe(false)
      const rendered = [error.message, JSON.stringify(error), String(error)]
      for (const output of rendered) {
        for (const secret of secrets(text)) expect(output).not.toContain(secret)
      }
    })
  }

  test("every refusal of a real key's lookalike hides the key", () => {
    for (const real of [HARDHAT_KEY_0, SOLANA_KEYPAIR_BASE58, SOLANA_KEYPAIR_JSON, HARDHAT_PHRASE]) {
      const error = refusal(`${real} extra`)
      const rendered = `${error.message} ${JSON.stringify(error)} ${String(error)}`
      for (const secret of secrets(real)) expect(rendered).not.toContain(secret)
    }
  })
})
