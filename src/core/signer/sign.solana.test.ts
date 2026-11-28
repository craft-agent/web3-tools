import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { inspect } from "node:util"
import { ed25519 } from "@noble/curves/ed25519.js"
import { base58, base64 } from "@scure/base"
import { systemTransfer } from "../solana/instructions"
import { compileLegacyMessage, decodeLegacyMessage } from "../solana/message"
import type { SolanaMessage } from "../solana/message"
import { TRANSFER_MESSAGE, TRANSFER_SIGNED_BYTES, TRANSFER_VECTOR } from "../solana/testing"
import { rawTransactionBase64, signSolanaTransaction, SignedSolanaTransaction } from "./sign.solana"
import {
  fakeRuntime,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_BASE58,
  writeWallet,
} from "./testing"

const PHRASE_ADDRESSES = ["oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96", "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD"]
const KEYPAIR_ADDRESS = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)))

/** The keypair of the transfer vector's sender, as Phantom exports it. */
const VECTOR_KEYPAIR = base58.encode(
  Uint8Array.of(...TRANSFER_VECTOR.seed, ...ed25519.getPublicKey(TRANSFER_VECTOR.seed)),
)

/** A transfer of 49 lamports from `from`, with the vector's recipient and blockhash. */
function transferFrom(from: string): SolanaMessage {
  return {
    feePayer: from,
    recentBlockhash: TRANSFER_VECTOR.blockhash,
    instructions: [systemTransfer(from, TRANSFER_VECTOR.recipient, TRANSFER_VECTOR.lamports)],
  }
}

/** The signature and message a signed transaction's bytes hold, for a single signer. */
function parts(raw: string): { signature: Uint8Array; message: Uint8Array } {
  const bytes = base64.decode(raw)
  expect(bytes[0]).toBe(1)
  return { signature: bytes.slice(1, 65), message: bytes.slice(65) }
}

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const lone = (address: string) => ({ label: "main", index: null, address })

describe("signSolanaTransaction: a lone keypair", () => {
  const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: VECTOR_KEYPAIR })

  test("signs the transfer of micro-sol-signer's vector to its bytes, and the signature is the id", async () => {
    const signed = await signSolanaTransaction(lone(TRANSFER_VECTOR.sender), TRANSFER_MESSAGE, runtime, stateDir)
    expect(base64.decode(rawTransactionBase64(signed))).toEqual(TRANSFER_SIGNED_BYTES)
    expect(signed.from).toBe(TRANSFER_VECTOR.sender)
    expect(signed.signature).toBe(base58.encode(TRANSFER_SIGNED_BYTES.slice(1, 65)))
  })

  test("signs the message the request compiles to, verifiably for the fee payer", async () => {
    const signed = await signSolanaTransaction(lone(TRANSFER_VECTOR.sender), TRANSFER_MESSAGE, runtime, stateDir)
    const { signature, message } = parts(rawTransactionBase64(signed))
    expect(message).toEqual(compileLegacyMessage(TRANSFER_MESSAGE))
    expect(decodeLegacyMessage(message)).toEqual(TRANSFER_MESSAGE)
    expect(ed25519.verify(signature, message, base58.decode(TRANSFER_VECTOR.sender))).toBe(true)
  })

  test("is deterministic: two signatures of one message are equal", async () => {
    const first = await signSolanaTransaction(lone(TRANSFER_VECTOR.sender), TRANSFER_MESSAGE, runtime, stateDir)
    const second = await signSolanaTransaction(lone(TRANSFER_VECTOR.sender), TRANSFER_MESSAGE, runtime, stateDir)
    expect(second.signature).toBe(first.signature)
    expect(rawTransactionBase64(second)).toBe(rawTransactionBase64(first))
  })

  test("takes index 0 of a lone key", async () => {
    const sender = { ...lone(TRANSFER_VECTOR.sender), index: 0 }
    expect((await signSolanaTransaction(sender, TRANSFER_MESSAGE, runtime, stateDir)).from).toBe(TRANSFER_VECTOR.sender)
  })
})

describe("signSolanaTransaction: a seed phrase", () => {
  const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_PHRASE })

  test("signs account 0 when no index is given, and account #1 on request", async () => {
    for (const [index, address] of PHRASE_ADDRESSES.entries()) {
      const sender = { label: "main", index: index === 0 ? null : index, address }
      const signed = await signSolanaTransaction(sender, transferFrom(address), runtime, stateDir)
      const { signature, message } = parts(rawTransactionBase64(signed))
      expect(signed.from).toBe(address)
      expect(decodeLegacyMessage(message)).toEqual(transferFrom(address))
      expect(ed25519.verify(signature, message, base58.decode(address))).toBe(true)
    }
  })

  test("reads the wallet's file when no variable is set", async () => {
    writeWallet(stateDir, "filed", HARDHAT_PHRASE)
    const sender = { label: "filed", index: 1, address: PHRASE_ADDRESSES[1] }
    const signed = await signSolanaTransaction(sender, transferFrom(sender.address), fakeRuntime(), stateDir)
    expect(signed.from).toBe(sender.address)
  })
})

describe("a signed transaction hides its bytes", () => {
  test("no string of it carries the raw transaction or a key, and only its signature and sender are listed", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: SOLANA_KEYPAIR_BASE58 })
    const signed = await signSolanaTransaction(lone(KEYPAIR_ADDRESS), transferFrom(KEYPAIR_ADDRESS), runtime, stateDir)
    const raw = rawTransactionBase64(signed)
    const shown = [JSON.stringify(signed), String(signed), `${signed}`, inspect(signed), inspect({ signed })]

    expect(JSON.parse(shown[0])).toEqual({ signature: signed.signature, from: KEYPAIR_ADDRESS })
    expect(shown[1]).toBe(signed.signature)
    expect(shown[3]).toBe(signed.signature)
    for (const text of shown) {
      expect(text).not.toContain(raw)
      expect(text).not.toContain(raw.slice(0, 40))
    }
    expect(holdsKeyMaterial(signed)).toBe(false)
    expect(Object.keys(signed)).toEqual(["signature", "from"])
    expect(Reflect.ownKeys(signed).every((key) => typeof key === "string")).toBe(true)
  })

  test("a signed transaction built from bytes names its first signature, and refuses bytes too short for one", () => {
    const signed = new SignedSolanaTransaction(TRANSFER_SIGNED_BYTES, TRANSFER_VECTOR.sender)
    expect(signed.signature).toBe(base58.encode(TRANSFER_SIGNED_BYTES.slice(1, 65)))
    expect(rawTransactionBase64(signed)).toBe(TRANSFER_VECTOR.signedBase64)
    expect(() => new SignedSolanaTransaction(TRANSFER_SIGNED_BYTES.slice(0, 40), TRANSFER_VECTOR.sender)).toThrow()
  })
})
