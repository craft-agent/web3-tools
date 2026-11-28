import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { rmSync } from "node:fs"
import { isToolError } from "../errors"
import type { ErrorCode } from "../errors"
import { SOLANA_PROGRAMS } from "../chains/solana"
import { systemTransfer } from "../solana/instructions"
import type { SolanaMessage } from "../solana/message"
import { testAddress, TRANSFER_VECTOR } from "../solana/testing"
import * as derive from "./derive"
import { signSolanaTransaction } from "./sign.solana"
import {
  fakeRuntime,
  HARDHAT_KEY_0,
  HARDHAT_PHRASE,
  holdsKeyMaterial,
  makeStateDir,
  SOLANA_KEYPAIR_BASE58,
  writeWallet,
} from "./testing"

const PHRASE_ADDRESSES = ["oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96", "AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD"]
const OTHER = testAddress(1)
const KEYPAIR_ADDRESS = derive.solanaAddress(new Uint8Array(32).fill(7))
const lone = (address: string) => ({ label: "main", index: null, address })

const KEY_RUNTIME = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: SOLANA_KEYPAIR_BASE58 })
const PHRASE_RUNTIME = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_PHRASE })

let stateDir: string

beforeEach(() => {
  stateDir = makeStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function transferFrom(from: string): SolanaMessage {
  return {
    feePayer: from,
    recentBlockhash: TRANSFER_VECTOR.blockhash,
    instructions: [systemTransfer(from, TRANSFER_VECTOR.recipient, 1n)],
  }
}

async function expectRefusal(code: ErrorCode, work: () => unknown): Promise<Error> {
  let error: Error | undefined
  try {
    await work()
  } catch (caught) {
    error = caught as Error
  }
  if (error === undefined) throw new Error("the call did not refuse")
  expect(isToolError(error) && error.code).toBe(code)
  expect(holdsKeyMaterial(error)).toBe(false)
  return error
}

describe("a key that no longer opens the address", () => {
  test("is stale, and signs nothing", async () => {
    const error = await expectRefusal("stale", () =>
      signSolanaTransaction({ label: "main", index: null, address: OTHER }, transferFrom(OTHER), KEY_RUNTIME, stateDir),
    )
    expect(error.message).toBe(`Wallet "main" no longer opens ${OTHER}; nothing was signed.`)
  })

  test("is stale for the wrong account of a seed phrase", async () => {
    const wrong = { label: "main", index: 2, address: PHRASE_ADDRESSES[1] }
    await expectRefusal("stale", () =>
      signSolanaTransaction(wrong, transferFrom(wrong.address), PHRASE_RUNTIME, stateDir),
    )
  })
})

describe("a key that cannot sign here", () => {
  test("an EVM key is invalid_argument, as resolveAccount refuses it", async () => {
    const runtime = fakeRuntime({ WEB3_TOOLS_WALLET_MAIN: HARDHAT_KEY_0 })
    const error = await expectRefusal("invalid_argument", () =>
      signSolanaTransaction({ label: "main", index: null, address: OTHER }, transferFrom(OTHER), runtime, stateDir),
    )
    expect(error.message).toBe('Wallet "main" holds an EVM key, which cannot act on Solana.')
  })

  test("an account other than #0 of a lone key is invalid_argument", async () => {
    const error = await expectRefusal("invalid_argument", () =>
      signSolanaTransaction({ label: "main", index: 3, address: OTHER }, transferFrom(OTHER), KEY_RUNTIME, stateDir),
    )
    expect(error.message).toContain("no account #3")
  })

  test("a wallet that is not set up passes its refusal through", async () => {
    await expectRefusal("unauthenticated", () =>
      signSolanaTransaction(
        { label: "absent", index: null, address: OTHER },
        transferFrom(OTHER),
        fakeRuntime(),
        stateDir,
      ),
    )
    writeWallet(stateDir, "loose", SOLANA_KEYPAIR_BASE58, 0o644)
    await expectRefusal("forbidden", () =>
      signSolanaTransaction(
        { label: "loose", index: null, address: OTHER },
        transferFrom(OTHER),
        fakeRuntime(),
        stateDir,
      ),
    )
  })
})

describe("a message that cannot be signed", () => {
  const sender = { label: "absent", index: null, address: OTHER }
  const message = transferFrom(OTHER)

  test("is invalid_argument before any key is read, which an absent wallet proves", async () => {
    const bad: SolanaMessage[] = [
      { ...message, recentBlockhash: "1111" },
      {
        ...message,
        instructions: [{ ...message.instructions[0], accounts: [{ address: "nope", signer: false, writable: true }] }],
      },
      { ...message, instructions: [{ ...message.instructions[0], data: new Uint8Array(1300) }] },
    ]
    for (const one of bad) {
      await expectRefusal("invalid_argument", () => signSolanaTransaction(sender, one, fakeRuntime(), stateDir))
    }
  })

  test("with a fee payer other than the sender is invalid_argument before any key is read", async () => {
    const error = await expectRefusal("invalid_argument", () =>
      signSolanaTransaction(sender, transferFrom(testAddress(2)), fakeRuntime(), stateDir),
    )
    expect(error.message).toContain(OTHER)
  })

  test("that needs another signer is invalid_argument before any key is read", async () => {
    const cosigned: SolanaMessage = {
      ...message,
      instructions: [
        {
          programId: SOLANA_PROGRAMS.systemProgram,
          accounts: [{ address: testAddress(3), signer: true, writable: false }],
          data: new Uint8Array(),
        },
      ],
    }
    const error = await expectRefusal("invalid_argument", () =>
      signSolanaTransaction(sender, cosigned, fakeRuntime(), stateDir),
    )
    expect(error.message).toContain("never co-signs")
  })
})

describe("a failure while the key is held", () => {
  const leak = () => {
    throw new Error(`${HARDHAT_PHRASE} ${SOLANA_KEYPAIR_BASE58}`)
  }

  test("in the derivation of a seed phrase's account is replaced by a fixed message with no cause", async () => {
    const spy = spyOn(derive, "phraseSeed").mockImplementation(leak)
    try {
      const sender = { label: "main", index: 0, address: PHRASE_ADDRESSES[0] }
      const error = await expectRefusal("internal_error", () =>
        signSolanaTransaction(sender, transferFrom(sender.address), PHRASE_RUNTIME, stateDir),
      )
      expect(error.message).toBe('The signer failed while signing for wallet "main".')
      expect(error.cause).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  test("in the derivation of the address is replaced the same way", async () => {
    const spy = spyOn(derive, "solanaAddress").mockImplementation(leak)
    try {
      const error = await expectRefusal("internal_error", () =>
        signSolanaTransaction(lone(KEYPAIR_ADDRESS), transferFrom(KEYPAIR_ADDRESS), KEY_RUNTIME, stateDir),
      )
      expect(error.message).toBe('The signer failed while signing for wallet "main".')
      expect(error.cause).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})

describe("the seed", () => {
  test.each([
    ["a lone key", KEY_RUNTIME, null],
    ["a seed phrase's account", PHRASE_RUNTIME, 0],
  ])("of %s is zeroed after signing, and so after a failure", async (_name, runtime, index) => {
    const address = index === null ? KEYPAIR_ADDRESS : PHRASE_ADDRESSES[0]
    const original = derive.solanaAddress
    let seen: Uint8Array | undefined
    let copy: Uint8Array | undefined
    const spy = spyOn(derive, "solanaAddress").mockImplementation((seed32) => {
      seen = seed32
      copy = new Uint8Array(seed32)
      return original(seed32)
    })
    try {
      await signSolanaTransaction({ label: "main", index, address }, transferFrom(address), runtime, stateDir)
      expect(copy?.some((byte) => byte !== 0)).toBe(true)
      expect(seen?.every((byte) => byte === 0)).toBe(true)

      spy.mockImplementation((seed32) => {
        seen = seed32
        copy = new Uint8Array(seed32)
        throw new Error("fails after reading the key")
      })
      await expectRefusal("internal_error", () =>
        signSolanaTransaction({ label: "main", index, address }, transferFrom(address), runtime, stateDir),
      )
      expect(copy?.some((byte) => byte !== 0)).toBe(true)
      expect(seen?.every((byte) => byte === 0)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
