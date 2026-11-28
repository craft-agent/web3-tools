import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { inspect } from "node:util"
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { Transaction } from "micro-eth-signer"
import type { EvmTransactionRequest } from "../evm/transaction"
import { placeholderSignedEvmTransactionHex } from "../evm/transaction"
import { rawTransactionHex, signEvmTransaction, SignedEvmTransaction } from "./sign"
import { fakeRuntime, HARDHAT_KEY_0, HARDHAT_PHRASE, holdsKeyMaterial, makeStateDir, writeWallet } from "./testing"

const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const HARDHAT_ADDRESSES = [ACCOUNT_0, ACCOUNT_1, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"]
const GWEI = 10n ** 9n

const REQUEST: EvmTransactionRequest = {
  chainId: 1,
  to: ACCOUNT_1,
  value: 10n ** 18n,
  data: "0xa9059cbb",
  nonce: 5n,
  gasLimit: 60_000n,
  maxFeePerGas: 30n * GWEI,
  maxPriorityFeePerGas: 2n * GWEI,
}

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const lone = (address = ACCOUNT_0) => ({ label: "main", index: null, address })

describe("signEvmTransaction: a lone EVM key", () => {
  const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })

  test("signs for the key's address, with the hash of the signed bytes", async () => {
    const signed = await signEvmTransaction(lone(), REQUEST, runtime, stateDir)
    const raw = rawTransactionHex(signed)
    expect(signed.from).toBe(ACCOUNT_0)
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(signed.hash).toBe(`0x${bytesToHex(keccak_256(hexToBytes(raw.slice(2))))}`)

    const decoded = Transaction.fromHex(raw)
    expect(decoded.isSigned).toBe(true)
    expect(decoded.hash).toBe(signed.hash)
    expect(decoded.recoverSender().address).toBe(ACCOUNT_0)
    expect(decoded.verifySignature()).toBe(true)
  })

  test("signs exactly the request: every field comes back", async () => {
    const decoded = Transaction.fromHex(rawTransactionHex(await signEvmTransaction(lone(), REQUEST, runtime, stateDir)))
    expect(decoded.type).toBe("eip1559")
    expect(decoded.raw).toMatchObject({
      chainId: BigInt(REQUEST.chainId),
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

  test("takes the sender's address in any case", async () => {
    const signed = await signEvmTransaction(lone(ACCOUNT_0.toLowerCase()), REQUEST, runtime, stateDir)
    expect(signed.from).toBe(ACCOUNT_0)
  })

  test("is hedged: two signatures of one request differ, each valid", async () => {
    const first = await signEvmTransaction(lone(), REQUEST, runtime, stateDir)
    const second = await signEvmTransaction(lone(), REQUEST, runtime, stateDir)
    expect(first.hash).not.toBe(second.hash)
    for (const signed of [first, second]) {
      expect(Transaction.fromHex(rawTransactionHex(signed)).recoverSender().address).toBe(ACCOUNT_0)
    }
  })

  test("takes index 0 of a lone key, and refuses another", async () => {
    expect((await signEvmTransaction({ ...lone(), index: 0 }, REQUEST, runtime, stateDir)).from).toBe(ACCOUNT_0)
    await expect(signEvmTransaction({ ...lone(), index: 1 }, REQUEST, runtime, stateDir)).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })
})

describe("signEvmTransaction: a seed phrase", () => {
  const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_PHRASE })

  test("signs account 0 when no index is given", async () => {
    const signed = await signEvmTransaction(lone(), REQUEST, runtime, stateDir)
    expect(signed.from).toBe(ACCOUNT_0)
  })

  test("signs account #1 as 0x70997970…79C8", async () => {
    const signed = await signEvmTransaction({ label: "main", index: 1, address: ACCOUNT_1 }, REQUEST, runtime, stateDir)
    expect(signed.from).toBe(ACCOUNT_1)
    expect(Transaction.fromHex(rawTransactionHex(signed)).recoverSender().address).toBe(ACCOUNT_1)
  })

  test("reads the wallet's file when no variable is set", async () => {
    writeWallet(stateDir, "filed", HARDHAT_PHRASE)
    const sender = { label: "filed", index: 1, address: ACCOUNT_1 }
    expect((await signEvmTransaction(sender, REQUEST, fakeRuntime(), stateDir)).from).toBe(ACCOUNT_1)
  })
})

describe("a signed transaction hides its bytes", () => {
  test("no string of it carries the raw transaction, and only its hash and sender are listed", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })
    const signed = await signEvmTransaction(lone(), REQUEST, runtime, stateDir)
    const raw = rawTransactionHex(signed)
    const shown = [
      JSON.stringify(signed),
      String(signed),
      `${signed}`,
      inspect(signed),
      inspect({ signed }),
      String(signed.toJSON()),
    ]

    expect(JSON.parse(shown[0])).toEqual({ hash: signed.hash, from: ACCOUNT_0 })
    expect(shown[1]).toBe(signed.hash)
    expect(shown[3]).toBe(signed.hash)
    for (const text of shown) {
      expect(text).not.toContain(raw.slice(2))
      expect(text).not.toContain(raw.slice(2, 40))
    }
    expect(holdsKeyMaterial(signed)).toBe(false)
    expect(Object.keys(signed)).toEqual(["hash", "from"])
    expect(Reflect.ownKeys(signed).every((key) => typeof key === "string")).toBe(true)
  })

  test("a signed transaction built from bytes hashes them", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const signed = new SignedEvmTransaction(bytes, ACCOUNT_0)
    expect(signed.hash).toBe(`0x${bytesToHex(keccak_256(bytes))}`)
    expect(rawTransactionHex(signed)).toBe("0x010203")
  })
})

describe("placeholderSignedEvmTransactionHex is an upper bound of a real signature", () => {
  test("is never shorter than the request signed by a key, over many signatures", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_PHRASE })
    for (let nonce = 0n; nonce < 24n; nonce++) {
      const request = { ...REQUEST, nonce, value: nonce * 10n ** 17n, data: nonce % 2n === 0n ? "0x" : REQUEST.data }
      const index = Number(nonce % BigInt(HARDHAT_ADDRESSES.length))
      const sender = { label: "main", index, address: HARDHAT_ADDRESSES[index] }
      const real = rawTransactionHex(await signEvmTransaction(sender, request, runtime, stateDir))
      expect(placeholderSignedEvmTransactionHex(request).length).toBeGreaterThanOrEqual(real.length)
    }
  })
})
