import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import type { MintFacts, TokenAccountFacts } from "./reads.token"
import { checkTransferable } from "./token-rules"
import { accountWith, extension, mintWith } from "./token-rules.fixtures"

function refusal(run: () => unknown): ToolError {
  try {
    run()
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("Expected a refusal, but nothing was refused")
}

const check = (
  mint: MintFacts,
  source: TokenAccountFacts | null = accountWith(),
  destination: TokenAccountFacts | null = accountWith(),
) => checkTransferable(mint, source, destination)

describe("checkTransferable: what a mint's extensions refuse", () => {
  test("a plain mint passes and has no permanent delegate", () => {
    expect(check(mintWith())).toEqual({ permanentDelegate: null })
  })

  test.each([
    ["transferFeeConfig", "transfer fee"],
    ["transferHook", "runs a program"],
    ["nonTransferable", "cannot be transferred"],
    ["confidentialTransferMint", "confidential transfers"],
    ["confidentialTransferFeeConfig", "confidential transfers"],
    ["confidentialMintBurn", "confidential transfers"],
  ])("%s is refused with its reason", (name, reason) => {
    const error = refusal(() => check(mintWith([extension(name)])))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("This token cannot be sent")
    expect(error.message).toContain(reason)
  })

  test("a hook with no program and a fee that charges nothing now or next are sent, as PYUSD's are", () => {
    const free = { epoch: 600, maximumFee: 0, transferFeeBasisPoints: 0 }
    const mint = mintWith([
      extension("transferHook", { authority: "x", programId: null }),
      extension("transferFeeConfig", { olderTransferFee: free, newerTransferFee: free }),
    ])
    const hooked = accountWith([extension("transferHookAccount", { transferring: false })])
    expect(check(mint, hooked, hooked)).toEqual({ permanentDelegate: null })
  })

  test("a fee that charges something now or next, or whose settings cannot be read, is refused", () => {
    const free = { maximumFee: 0, transferFeeBasisPoints: 0 }
    const charged = { maximumFee: 5000, transferFeeBasisPoints: 25 }
    for (const state of [
      { olderTransferFee: free, newerTransferFee: charged },
      { olderTransferFee: charged, newerTransferFee: free },
      { newerTransferFee: free },
    ]) {
      expect(refusal(() => check(mintWith([extension("transferFeeConfig", state)]))).message).toContain("transfer fee")
    }
  })

  test("a hook with a program is refused, and so is its account extension", () => {
    const hook = extension("transferHook", { programId: "HookProgram111111111111111111111111111111111" })
    expect(refusal(() => check(mintWith([hook]))).message).toContain("runs a program")
    const account = accountWith([extension("transferHookAccount", { transferring: false })])
    expect(refusal(() => check(mintWith(), account, accountWith())).message).toContain("runs a program")
  })

  test("new accounts frozen by default refuse a send that creates the recipient's, and no other", () => {
    const frozen = mintWith([extension("defaultAccountState", { accountState: "frozen" })])
    expect(refusal(() => check(frozen, accountWith(), null)).message).toContain("start frozen")
    expect(check(frozen, accountWith(), accountWith())).toEqual({ permanentDelegate: null })
    const initialized = mintWith([extension("defaultAccountState", { accountState: "initialized" })])
    expect(check(initialized, accountWith(), null)).toEqual({ permanentDelegate: null })
  })

  test("a paused mint is refused and one that is not paused is not", () => {
    expect(refusal(() => check(mintWith([extension("pausableConfig", { paused: true })]))).message).toContain("paused")
    expect(check(mintWith([extension("pausableConfig", { authority: null, paused: false })]))).toEqual({
      permanentDelegate: null,
    })
  })

  test("a state these rules cannot read fails closed", () => {
    for (const bad of [
      extension("defaultAccountState", { accountState: "uninitialized" }),
      extension("defaultAccountState"),
      extension("pausableConfig", { paused: "no" }),
      extension("pausableConfig"),
      extension("permanentDelegate", { delegate: 5 }),
    ]) {
      expect(refusal(() => check(mintWith([bad]))).message).toContain(`its ${bad.name} extension has a state`)
    }
  })

  test("an extension that is not known is refused, quoting its name up to 40 characters", () => {
    for (const name of ["permissionedBurnConfig", "unparseableExtension", "uninitialized", "somethingNew"]) {
      const error = refusal(() => check(mintWith([extension(name)])))
      expect(error.message).toContain("an extension these tools do not know")
      expect(error.message).toContain(JSON.stringify(name))
    }
    const long = refusal(() => check(mintWith([extension("x".repeat(100))])))
    expect(long.message).toContain(JSON.stringify("x".repeat(40)))
    expect(long.message).not.toContain("x".repeat(41))
  })

  test("a refused extension is refused whatever comes before it", () => {
    const mint = mintWith([extension("metadataPointer"), extension("tokenMetadata"), extension("transferHook")])
    expect(refusal(() => check(mint)).message).toContain("runs a program")
  })
})

describe("checkTransferable: what is allowed", () => {
  test.each([
    "metadataPointer",
    "tokenMetadata",
    "groupPointer",
    "groupMemberPointer",
    "tokenGroup",
    "tokenGroupMember",
    "interestBearingConfig",
    "scaledUiAmountConfig",
    "mintCloseAuthority",
  ])("the mint extension %s is display-only", (name) => {
    expect(check(mintWith([extension(name, { authority: null })]))).toEqual({ permanentDelegate: null })
  })

  test.each(["immutableOwner", "transferFeeAmount", "cpiGuard", "pausableAccount"])(
    "the account extension %s does not stop a transfer, on either side",
    (name) => {
      const account = accountWith([extension(name, { lockCpi: true, withheldAmount: 5 })])
      expect(check(mintWith(), account, account)).toEqual({ permanentDelegate: null })
    },
  )

  test("a real mint's display extensions pass", () => {
    const extensions = ["metadataPointer", "tokenMetadata", "mintCloseAuthority"].map((name) => extension(name))
    expect(check(mintWith(extensions))).toEqual({ permanentDelegate: null })
  })
})

describe("checkTransferable: the permanent delegate", () => {
  test("is returned for the prompt, and the transfer is allowed", () => {
    expect(check(mintWith([extension("permanentDelegate", { delegate: "Delegate1111" })]))).toEqual({
      permanentDelegate: "Delegate1111",
    })
  })

  test("is null when the extension has no delegate", () => {
    expect(check(mintWith([extension("permanentDelegate", { delegate: null })]))).toEqual({ permanentDelegate: null })
    expect(check(mintWith([extension("permanentDelegate")]))).toEqual({ permanentDelegate: null })
  })
})

describe("checkTransferable: the accounts", () => {
  test("a frozen source or destination is refused, each named", () => {
    expect(refusal(() => check(mintWith(), accountWith([], "frozen"))).message).toContain(
      "the source token account is frozen",
    )
    expect(refusal(() => check(mintWith(), accountWith(), accountWith([], "frozen"))).message).toContain(
      "the recipient's token account is frozen",
    )
  })

  test("a destination that requires incoming memos is refused, and one that does not, or a source that does, is not", () => {
    const requires = accountWith([extension("memoTransfer", { requireIncomingTransferMemos: true })])
    const optional = accountWith([extension("memoTransfer", { requireIncomingTransferMemos: false })])
    expect(refusal(() => check(mintWith(), accountWith(), requires)).message).toContain("requires a memo")
    expect(check(mintWith(), accountWith(), optional)).toEqual({ permanentDelegate: null })
    expect(check(mintWith(), requires, accountWith())).toEqual({ permanentDelegate: null })
    const unreadable = accountWith([extension("memoTransfer")])
    expect(refusal(() => check(mintWith(), accountWith(), unreadable)).message).toContain(
      "memoTransfer extension has a state",
    )
  })

  test("an account's own refused or unknown extension is refused", () => {
    expect(refusal(() => check(mintWith(), accountWith([extension("nonTransferableAccount")]))).message).toContain(
      "the source token account cannot be transferred",
    )
    expect(
      refusal(() => check(mintWith(), accountWith(), accountWith([extension("transferHookAccount")]))).message,
    ).toContain("runs a program")
    expect(refusal(() => check(mintWith(), accountWith([extension("somethingNew")]))).message).toContain("do not know")
  })

  test("a send that creates the recipient's account and has no source account still checks the mint", () => {
    expect(check(mintWith(), null, null)).toEqual({ permanentDelegate: null })
    expect(refusal(() => check(mintWith([extension("transferHook")]), null, null)).message).toContain("runs a program")
  })
})
