import { afterEach, describe, expect, test } from "bun:test"
import { SOLANA_PROGRAMS } from "../chains/solana"
import {
  BOB,
  cleanRigs,
  expectRefused,
  MAIN_ADDRESS,
  MAIN_TOKENS,
  makeRig,
  MINT,
  solArgs,
  tokenArgs,
} from "./send.testing"
import { testAddress } from "./testing"

afterEach(cleanRigs)

const CANNOT_SEND = "invalid_argument"

describe("tokens that cannot be sent", () => {
  test("an address with no account, a wallet and a compressed asset are no token mint", async () => {
    await expectRefused(makeRig(), tokenArgs({ mint: testAddress(7) }), CANNOT_SEND, /no account is there/)
    await expectRefused(makeRig(), tokenArgs({ mint: MAIN_ADDRESS }), CANNOT_SEND, /not a Token or Token-2022 mint/)
  })

  test("a wallet with no token account for the mint holds none of it", async () => {
    const rig = makeRig()
    rig.fake.addMint(testAddress(6), { decimals: 6 })
    await expectRefused(rig, tokenArgs({ mint: testAddress(6) }), CANNOT_SEND, /holds none of the token/)
  })

  test("more than the wallet holds", async () => {
    await expectRefused(
      makeRig(),
      tokenArgs({ amount: "1001" }),
      CANNOT_SEND,
      /holds 1000 of the token.*less than the 1001/,
    )
  })

  const extensions = [
    ["a transfer fee", { extension: "transferFeeConfig", state: {} }, /transfer fee/],
    [
      "a transfer hook",
      { extension: "transferHook", state: { programId: testAddress(8) } },
      /program of the token's choosing/,
    ],
    ["non-transferable tokens", { extension: "nonTransferable" }, /cannot be transferred/],
    ["confidential transfers", { extension: "confidentialTransferMint", state: {} }, /confidential transfers/],
    ["a paused mint", { extension: "pausableConfig", state: { paused: true } }, /the token is paused/],
    [
      "new accounts frozen by default",
      { extension: "defaultAccountState", state: { accountState: "frozen" } },
      /start frozen/,
    ],
    ["an extension no rule knows", { extension: "someFutureExtension", state: {} }, /do not know/],
  ] as const

  test.each(extensions)("%s", async (_name, extension, message) => {
    const rig = makeRig()
    rig.fake.addMint(MINT, { decimals: 6, extensions: [extension] })
    await expectRefused(rig, tokenArgs(), CANNOT_SEND, message)
  })

  test("a memo the recipient's token account requires", async () => {
    const rig = makeRig()
    rig.fake.addAssociatedTokenAccount(BOB, MINT, {
      program: SOLANA_PROGRAMS.tokenProgram,
      extensions: [{ extension: "memoTransfer", state: { requireIncomingTransferMemos: true } }],
    })
    await expectRefused(rig, tokenArgs(), CANNOT_SEND, /requires a memo/)
  })

  test("a frozen token account of the sender", async () => {
    const rig = makeRig()
    rig.fake.addAssociatedTokenAccount(MAIN_ADDRESS, MINT, { amount: MAIN_TOKENS, state: "frozen" })
    await expectRefused(rig, tokenArgs(), CANNOT_SEND, /source token account is frozen/)
  })

  test("a transfer hook with no program and a fee that charges nothing change nothing, so they are sent", async () => {
    const rig = makeRig()
    const free = { transferFeeBasisPoints: 0, maximumFee: 0 }
    rig.fake.addMint(MINT, {
      decimals: 6,
      extensions: [
        { extension: "transferHook", state: { programId: null } },
        { extension: "transferFeeConfig", state: { olderTransferFee: free, newerTransferFee: free } },
      ],
    })
    expect((await rig.run(tokenArgs())).outcome).toBe("confirmed")
  })
})

describe("what the cluster and the fees say", () => {
  function failSimulations(rig: ReturnType<typeof makeRig>): void {
    rig.beforeRequest = (method) => {
      if (method !== "simulateTransaction") return
      const value = {
        err: { InstructionError: [0, "InvalidAccountData"] },
        logs: ["Program log: boom"],
        unitsConsumed: 5,
      }
      rig.fake.inject("simulateTransaction", { result: { context: { slot: 1 }, value } })
    }
  }

  test("a transaction the cluster would fail is refused with the cluster's reason", async () => {
    const rig = makeRig()
    failSimulations(rig)
    await expectRefused(rig, solArgs(), CANNOT_SEND, /would fail this transaction.*InvalidAccountData.*boom/)
  })

  test("the simulation of a token send that makes an account fails the same way", async () => {
    const rig = makeRig()
    failSimulations(rig)
    await expectRefused(rig, tokenArgs(), CANNOT_SEND, /would fail this transaction.*InvalidAccountData/)
  })

  test("a max_fee below what the cluster asks is refused with a value that leaves room", async () => {
    const rig = makeRig()
    rig.fake.priorityFees = [10_000_000n]
    await expectRefused(rig, solArgs({ max_fee: "4999" }), CANNOT_SEND, /below the \d+ lamports the network asks now/)
    const approval = await rig.approve(solArgs({ max_fee: "6000" }))
    const [, needed, suggested] =
      /below the (\d+) lamports.*; (\d+) lamports leaves room/.exec(approval.refused?.message ?? "") ?? []
    expect(BigInt(suggested!)).toBeGreaterThan(BigInt(needed!))
    expect((await rig.run(solArgs({ max_fee: suggested! }))).outcome).toBe("confirmed")
  })
})
