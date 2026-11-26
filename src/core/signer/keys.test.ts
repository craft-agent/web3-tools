import { describe, expect, test } from "bun:test"
import { hexToBytes } from "@noble/curves/utils.js"
import { base58 } from "@scure/base"
import { generateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { inspect } from "node:util"
import { keyMaterial, parseKey, WalletKey } from "./keys"
import { ABANDON_PHRASE, HARDHAT_KEY_0, HARDHAT_PHRASE, SOLANA_KEYPAIR_BASE58, SOLANA_KEYPAIR_JSON } from "./testing"

const HARDHAT_SECRET = hexToBytes(HARDHAT_KEY_0.slice(2))
const SOLANA_KEYPAIR = base58.decode(SOLANA_KEYPAIR_BASE58)

describe("parseKey: seed phrases", () => {
  test("accepts a phrase and keeps it in normal form", () => {
    const key = parseKey(HARDHAT_PHRASE, "main")
    expect(key.kind).toBe("phrase")
    expect(key.words).toBe(12)
    expect(keyMaterial(key)).toEqual({ phrase: HARDHAT_PHRASE, secret: undefined })
    expect(key.families()).toEqual(["evm", "solana"])
  })

  test("ignores extra spaces, newlines, tabs and upper case", () => {
    const messy = `  \n TEST  test\ttest test\n\ntest test test test test test test JUNK \r\n`
    expect(keyMaterial(parseKey(messy, "main")).phrase).toBe(HARDHAT_PHRASE)
  })

  test("normalizes composed and wide characters (NFKD)", () => {
    const wide = HARDHAT_PHRASE.replace("test test", "ｔｅｓｔ\u3000ＴＥＳＴ")
    expect(keyMaterial(parseKey(wide, "main")).phrase).toBe(HARDHAT_PHRASE)
    expect(keyMaterial(parseKey(ABANDON_PHRASE, "main")).phrase).toBe(ABANDON_PHRASE)
  })

  test("accepts a valid phrase of each of the five lengths", () => {
    for (const [strength, words] of [
      [128, 12],
      [160, 15],
      [192, 18],
      [224, 21],
      [256, 24],
    ] as const) {
      const phrase = generateMnemonic(wordlist, strength)
      const key = parseKey(` ${phrase.replaceAll(" ", "  ")}\n`, "main")
      expect(key.kind).toBe("phrase")
      expect(key.words).toBe(words)
      expect(keyMaterial(key).phrase).toBe(phrase)
    }
  })
})

describe("parseKey: EVM private keys", () => {
  test("accepts 64 hex digits with or without 0x", () => {
    for (const text of [HARDHAT_KEY_0, HARDHAT_KEY_0.slice(2), ` ${HARDHAT_KEY_0}\n`]) {
      const key = parseKey(text, "main")
      expect(key.kind).toBe("evm")
      expect(key.words).toBeUndefined()
      expect(keyMaterial(key)).toEqual({ phrase: undefined, secret: HARDHAT_SECRET })
      expect(key.families()).toEqual(["evm"])
    }
  })

  test("accepts upper and mixed-case digits", () => {
    const digits = HARDHAT_KEY_0.slice(2)
    const mixed = digits.slice(0, 32).toUpperCase() + digits.slice(32)
    for (const text of [digits.toUpperCase(), `0x${digits.toUpperCase()}`, mixed, `0x${mixed}`]) {
      expect(keyMaterial(parseKey(text, "main")).secret).toEqual(HARDHAT_SECRET)
    }
  })

  test("accepts the smallest scalar and the one below the curve order", () => {
    const smallest = `${"0".repeat(63)}1`
    const largest = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140"
    expect(parseKey(smallest, "main").kind).toBe("evm")
    expect(parseKey(largest, "main").kind).toBe("evm")
  })
})

describe("parseKey: Solana keypairs", () => {
  test("accepts base58", () => {
    const key = parseKey(` ${SOLANA_KEYPAIR_BASE58}\n`, "main")
    expect(key.kind).toBe("solana")
    expect(keyMaterial(key).secret).toEqual(SOLANA_KEYPAIR)
    expect(key.families()).toEqual(["solana"])
  })

  test("accepts a JSON array, on one line or several", () => {
    for (const text of [SOLANA_KEYPAIR_JSON, JSON.stringify(JSON.parse(SOLANA_KEYPAIR_JSON), null, 2)]) {
      const key = parseKey(`\n${text}\n`, "main")
      expect(key.kind).toBe("solana")
      expect(keyMaterial(key).secret).toEqual(SOLANA_KEYPAIR)
    }
  })
})

describe("WalletKey", () => {
  const keys = [HARDHAT_PHRASE, HARDHAT_KEY_0, SOLANA_KEYPAIR_BASE58].map((text) => parseKey(text, "main"))
  const material = [HARDHAT_PHRASE, ...HARDHAT_PHRASE.split(" "), HARDHAT_KEY_0.slice(2), SOLANA_KEYPAIR_BASE58]

  test("shows its kind and nothing else in every rendering", () => {
    const [phrase, evm, solana] = keys as [WalletKey, WalletKey, WalletKey]
    expect(JSON.parse(JSON.stringify(phrase))).toEqual({ kind: "phrase", words: 12 })
    expect(JSON.parse(JSON.stringify(evm))).toEqual({ kind: "evm" })
    expect(String(solana)).toBe("[wallet key: solana]")
    expect(`${evm}`).toBe("[wallet key: evm]")
    expect(inspect(phrase)).toBe("[wallet key: phrase]")
    expect(inspect({ nested: [evm] }, { depth: 5 })).toContain("[wallet key: evm]")
    for (const key of keys) {
      const rendered = [JSON.stringify(key), String(key), `${key}`, inspect(key), inspect(key, { showHidden: true })]
      for (const text of rendered) {
        for (const secret of material) expect(text).not.toContain(secret)
      }
      expect(Object.keys(key).sort()).toEqual(key.words === undefined ? ["kind"] : ["kind", "words"])
    }
  })

  test("gives copies of its material", () => {
    const key = parseKey(HARDHAT_KEY_0, "main")
    keyMaterial(key).secret?.fill(0)
    expect(keyMaterial(key).secret).toEqual(HARDHAT_SECRET)
  })

  test("refuses material that does not fit its kind", () => {
    expect(() => new WalletKey("evm", { secret: new Uint8Array(31) })).toThrow("another kind")
    expect(() => new WalletKey("solana", { secret: new Uint8Array(32) })).toThrow("another kind")
    expect(() => new WalletKey("phrase", {})).toThrow("another kind")
    expect(() => new WalletKey("phrase", { phrase: "a", secret: new Uint8Array(32) })).toThrow("another kind")
  })
})
