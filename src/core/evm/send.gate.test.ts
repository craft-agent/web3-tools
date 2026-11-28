import { afterEach, describe, expect, test } from "bun:test"
import { HYPERLIQUID_BRIDGE_ADDRESSES } from "../chains/evm"
import type { ErrorCode } from "../errors"
import { cleanRigs, ETHER, makeRig, nativeArgs, TOKEN_ADDRESS, tokenArgs, type SendRig } from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

/** The call is refused before anyone is asked and again when it runs, with nothing signed, broadcast or recorded. */
async function expectRefused(rig: SendRig, args: unknown, code: ErrorCode, message: RegExp): Promise<void> {
  const approval = await rig.approve(args)
  expect(approval.refused).toMatchObject({ code })
  expect(approval.refused?.message).toMatch(message)
  const error = await rig.run(args).catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code })
  expect(rig.fake.requestsOf("eth_sendRawTransaction")).toHaveLength(0)
  expect(await rig.rows()).toEqual([])
}

describe("the arguments of a send", () => {
  test("a name is refused with a request for the address", async () => {
    await expectRefused(
      makeRig(),
      nativeArgs({ to: "vitalik.eth" }),
      "invalid_argument",
      /0x address.*give the address/,
    )
  })

  test("a token that is not an address is refused", async () => {
    await expectRefused(makeRig(), tokenArgs({ token: "usdc" }), "invalid_argument", /token must be a 0x address/)
  })

  test("an address with capitals that fail its checksum is refused", async () => {
    const to = HARDHAT_ADDRESS_1.slice(0, -1) + (HARDHAT_ADDRESS_1.endsWith("8") ? "9" : "8")
    await expectRefused(makeRig(), nativeArgs({ to }), "invalid_argument", /checksum/)
  })

  test("an amount more precise than the token is refused, never rounded", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { decimals: 6, balances: { [HARDHAT_ADDRESS_0]: 100_000_000n } })
    await expectRefused(
      rig,
      tokenArgs({ amount: "0.0000001" }),
      "invalid_argument",
      /more decimal places than the token/,
    )
    await expectRefused(makeRig(), nativeArgs({ amount: "0.0000000000000000001" }), "invalid_argument", /decimals/)
  })

  test("an amount or a max_fee that is not plain digits is refused", async () => {
    await expectRefused(makeRig(), nativeArgs({ amount: "1e3" }), "invalid_argument", /amount/)
    await expectRefused(makeRig(), nativeArgs({ amount: "0" }), "invalid_argument", /more than 0/)
    await expectRefused(makeRig(), nativeArgs({ max_fee: "0.5" }), "invalid_argument", /max_fee/)
  })

  test("a sender with no key is refused before any request to the chain", async () => {
    const rig = makeRig()
    const approval = await rig.approve(nativeArgs({ account: "ghost" }))
    expect(approval.refused).toBeDefined()
    expect(approval.resources).toBeUndefined()
    expect(rig.fake.requests).toHaveLength(0)
  })

  test("with several wallets and no account the choice is refused, naming them", async () => {
    const rig = makeRig()
    const { account: _account, ...args } = nativeArgs()
    await expectRefused(rig, args, "invalid_argument", /main, savings/)
  })

  test("an unknown chain or argument is refused by the schema", async () => {
    const rig = makeRig()
    await expect(rig.invoke(nativeArgs({ chain: "nowhere" }))).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(rig.invoke(nativeArgs({ token_id: "1" }))).rejects.toMatchObject({ code: "invalid_argument" })
  })
})

describe("recipients no one should send to", () => {
  test("the zero address", async () => {
    await expectRefused(makeRig(), nativeArgs({ to: `0x${"0".repeat(40)}` }), "invalid_argument", /zero address/)
  })

  test("the sending wallet itself", async () => {
    await expectRefused(makeRig(), nativeArgs({ to: HARDHAT_ADDRESS_0.toLowerCase() }), "invalid_argument", /itself/)
  })

  test.each(HYPERLIQUID_BRIDGE_ADDRESSES)(
    "Hyperliquid's deprecated deposit bridge $address, on any chain",
    async ({ address }) => {
      const message = /Hyperliquid's deprecated deposit bridge.*lost/
      await expectRefused(makeRig(), nativeArgs({ to: address }), "invalid_argument", message)
      await expectRefused(
        makeRig({ chain: "base" }),
        tokenArgs({ chain: "base", to: address }),
        "invalid_argument",
        message,
      )
    },
  )

  test("the token's own contract", async () => {
    await expectRefused(makeRig(), tokenArgs({ to: TOKEN_ADDRESS }), "invalid_argument", /token's own contract/)
  })
})

describe("tokens that are not tokens", () => {
  test("an address without code", async () => {
    await expectRefused(makeRig(), tokenArgs({ token: HARDHAT_ADDRESS_1 }), "invalid_argument", /no contract at/)
  })

  test("a contract whose decimals cannot be read", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { decimals: "revert", balances: { [HARDHAT_ADDRESS_0]: ETHER } })
    await expectRefused(rig, tokenArgs(), "invalid_argument", /not an ERC-20 token/)
  })

  test("a token whose transfer returns false", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { transfer: "false", balances: { [HARDHAT_ADDRESS_0]: 100n * ETHER } })
    await expectRefused(rig, tokenArgs(), "invalid_argument", /transfer returned false/)
  })

  test("a token whose transfer reverts, with its reason", async () => {
    const rig = makeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { transfer: "revert", balances: { [HARDHAT_ADDRESS_0]: 100n * ETHER } })
    await expectRefused(rig, tokenArgs(), "invalid_argument", /would revert this transaction.*transfer failed/)
  })

  test("a native send the chain would revert, with the chain's reason", async () => {
    const rig = makeRig()
    rig.fake.estimateRevert = "blocked recipient"
    await expectRefused(rig, nativeArgs(), "invalid_argument", /would revert this transaction.*blocked recipient/)
  })
})

describe("balances", () => {
  test("a native send needs the amount and max_fee together, and the refusal names the balance", async () => {
    const rig = makeRig()
    const message = new RegExp(`holds ${10n * ETHER} wei \\(10 ETH\\).*smaller amount or give a smaller max_fee`)
    await expectRefused(rig, nativeArgs({ amount: "10" }), "invalid_argument", message)
    await expectRefused(rig, nativeArgs({ amount: "11" }), "invalid_argument", message)
  })

  test("a native send of everything but the fee goes through", async () => {
    const rig = makeRig()
    expect((await rig.run(nativeArgs({ amount: "9.9997" }))).outcome).toBe("confirmed")
  })

  test("a token send needs the amount in the token", async () => {
    const rig = makeRig()
    await expectRefused(
      rig,
      tokenArgs({ amount: "1001" }),
      "invalid_argument",
      /holds 1000 of the token.*less than the 1001/,
    )
  })

  test("a token send needs the fee in the native coin", async () => {
    const rig = makeRig()
    rig.fake.setBalance(HARDHAT_ADDRESS_0, 10n ** 14n)
    await expectRefused(rig, tokenArgs(), "invalid_argument", /holds 100000000000000 wei.*max_fee/)
  })

  test("the chain's native coin as an ERC-20 is one balance for the amount and the fee", async () => {
    const rig = makeRig({ chain: "celo" })
    rig.fake.addErc20("0x471EcE3750Da237f93B8E339c536989b8978a438", {
      balances: { [HARDHAT_ADDRESS_0]: 10n * ETHER },
    })
    await expectRefused(
      rig,
      tokenArgs({ chain: "celo", token: "0x471EcE3750Da237f93B8E339c536989b8978a438", amount: "10" }),
      "invalid_argument",
      /the amount and max_fee/,
    )
  })
})
