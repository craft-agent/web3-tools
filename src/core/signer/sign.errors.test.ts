import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { rmSync } from "node:fs"
import { Transaction } from "micro-eth-signer"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import type { EvmTransaction, EvmTransactionRequest } from "../evm/transaction"
import * as derive from "./derive"
import { rawTransactionHex, signEvmTransaction } from "./sign"
import {
  fakeRuntime,
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_BASE58,
  writeWallet,
} from "./testing"

const ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const GWEI = 10n ** 9n

const REQUEST: EvmTransactionRequest = {
  chainId: 1,
  to: ACCOUNT_1,
  value: 1n,
  data: "0x",
  nonce: 0n,
  gasLimit: 21_000n,
  maxFeePerGas: 30n * GWEI,
  maxPriorityFeePerGas: GWEI,
}

const KEY_RUNTIME = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })
const PHRASE_RUNTIME = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_PHRASE })

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

async function failure(work: () => unknown): Promise<Error> {
  try {
    await work()
  } catch (error) {
    return error as Error
  }
  throw new Error("the call did not refuse")
}

async function expectRefusal(code: ErrorCode, work: () => unknown): Promise<Error> {
  const error = await failure(work)
  expect(isToolError(error) && error.code).toBe(code)
  expect(holdsKeyMaterial(error)).toBe(false)
  return error
}

describe("a key that no longer opens the address", () => {
  test("is stale, and signs nothing", async () => {
    const sign = spyOn(Transaction.prototype, "signBy")
    try {
      const error = await expectRefusal("stale", () =>
        signEvmTransaction({ label: "main", index: null, address: ACCOUNT_1 }, REQUEST, KEY_RUNTIME, stateDir),
      )
      expect(error.message).toBe(`Wallet "main" no longer opens ${ACCOUNT_1}; nothing was signed.`)
      expect(sign).not.toHaveBeenCalled()
    } finally {
      sign.mockRestore()
    }
  })

  test("is stale for the wrong account of a seed phrase", async () => {
    await expectRefusal("stale", () =>
      signEvmTransaction({ label: "main", index: 2, address: ACCOUNT_1 }, REQUEST, PHRASE_RUNTIME, stateDir),
    )
  })
})

describe("a key that cannot sign here", () => {
  test("a Solana keypair is invalid_argument, as resolveAccount refuses it", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: SOLANA_KEYPAIR_BASE58 })
    const error = await expectRefusal("invalid_argument", () =>
      signEvmTransaction({ label: "main", index: null, address: ACCOUNT_0 }, REQUEST, runtime, stateDir),
    )
    expect(error.message).toBe('Wallet "main" holds a Solana key, which cannot act on EVM chains.')
  })

  test("an account other than #0 of a lone key is invalid_argument", async () => {
    const error = await expectRefusal("invalid_argument", () =>
      signEvmTransaction({ label: "main", index: 3, address: ACCOUNT_0 }, REQUEST, KEY_RUNTIME, stateDir),
    )
    expect(error.message).toContain("no account #3")
  })

  test("a wallet that is not set up passes its refusal through", async () => {
    await expectRefusal("unauthenticated", () =>
      signEvmTransaction({ label: "absent", index: null, address: ACCOUNT_0 }, REQUEST, fakeRuntime(), stateDir),
    )
    writeWallet(stateDir, "loose", HARDHAT_KEY_0, 0o644)
    await expectRefusal("forbidden", () =>
      signEvmTransaction({ label: "loose", index: null, address: ACCOUNT_0 }, REQUEST, fakeRuntime(), stateDir),
    )
  })
})

describe("a request that cannot be signed", () => {
  test("is invalid_argument before any key is read", async () => {
    const sender = { label: "absent", index: null, address: ACCOUNT_0 }
    for (const bad of [{ gasLimit: 1n }, { chainId: 0 }, { to: "0x1234" }, { maxPriorityFeePerGas: 31n * GWEI }]) {
      await expectRefusal("invalid_argument", () =>
        signEvmTransaction(sender, { ...REQUEST, ...bad }, fakeRuntime(), stateDir),
      )
    }
  })
})

describe("a failure while the key is held", () => {
  test("inside the library is replaced by a fixed message with no cause", async () => {
    const sign = spyOn(Transaction.prototype, "signBy").mockImplementation(() => {
      throw new Error(`${HARDHAT_KEY_0} ${HARDHAT_PHRASE}`)
    })
    try {
      const error = await expectRefusal("internal_error", () =>
        signEvmTransaction({ label: "main", index: null, address: ACCOUNT_0 }, REQUEST, KEY_RUNTIME, stateDir),
      )
      expect(error.message).toBe('The signer failed while signing for wallet "main".')
      expect(error.cause).toBeUndefined()
    } finally {
      sign.mockRestore()
    }
  })

  test("in the derivation of a seed phrase's account is replaced the same way", async () => {
    const seed = spyOn(derive, "phraseSeed").mockImplementation(() => {
      throw new Error(HARDHAT_PHRASE)
    })
    try {
      const error = await expectRefusal("internal_error", () =>
        signEvmTransaction({ label: "main", index: 0, address: ACCOUNT_0 }, REQUEST, PHRASE_RUNTIME, stateDir),
      )
      expect(error.message).toBe('The signer failed while signing for wallet "main".')
      expect(error.cause).toBeUndefined()
    } finally {
      seed.mockRestore()
    }
  })

  test("a signature that does not recover the address is an error, not a result", async () => {
    const recover = spyOn(Transaction.prototype, "recoverSender").mockImplementation(() => ({
      publicKey: "0x",
      address: ACCOUNT_1,
    }))
    try {
      await expectRefusal("internal_error", () =>
        signEvmTransaction({ label: "main", index: null, address: ACCOUNT_0 }, REQUEST, KEY_RUNTIME, stateDir),
      )
    } finally {
      recover.mockRestore()
    }
  })
})

describe("the secret", () => {
  test.each([
    ["a lone key", KEY_RUNTIME, null],
    ["a seed phrase's account", PHRASE_RUNTIME, 0],
  ])("of %s is zeroed after signing, and so after a failure", async (_name, runtime, index) => {
    const sender = { label: "main", index, address: ACCOUNT_0 }
    const original = Transaction.prototype.signBy
    let seen: Uint8Array | undefined
    let copy: Uint8Array | undefined
    const sign = spyOn(Transaction.prototype, "signBy").mockImplementation(function (this: EvmTransaction, key) {
      seen = key as Uint8Array
      copy = new Uint8Array(seen)
      return original.call(this, key)
    })
    try {
      const signed = await signEvmTransaction(sender, REQUEST, runtime, stateDir)
      expect(rawTransactionHex(signed)).toMatch(/^0x02/)
      expect(copy?.some((byte) => byte !== 0)).toBe(true)
      expect(seen?.every((byte) => byte === 0)).toBe(true)

      sign.mockImplementation(function (this: EvmTransaction, key) {
        seen = key as Uint8Array
        copy = new Uint8Array(seen)
        throw new Error("fails after reading the key")
      })
      await expectRefusal("internal_error", () => signEvmTransaction(sender, REQUEST, runtime, stateDir))
      expect(copy?.some((byte) => byte !== 0)).toBe(true)
      expect(seen?.every((byte) => byte === 0)).toBe(true)
    } finally {
      sign.mockRestore()
    }
  })
})
