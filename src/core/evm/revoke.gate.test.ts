import { afterEach, describe, expect, test } from "bun:test"
import { checkPin } from "../../entry/pin"
import { makeRevokeRig, revokeArgs, SPENDER_ADDRESS, type RevokeRig } from "./revoke.testing"
import { cleanRigs, COLLECTION_ADDRESS, ERC721_ID, expectRefused, TOKEN_ADDRESS } from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

const SPENDER = SPENDER_ADDRESS.toLowerCase()
const ALLOWANCE_SELECTOR = "0xdd62ed3e"
const DECIMALS_SELECTOR = "0x313ce567"
const NO_APPROVAL = /has no approval for .* to revoke/

function rigWithAllowance(): RevokeRig {
  const rig = makeRevokeRig()
  rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n } } })
  return rig
}

/** Makes the next `eth_call` of a read that starts with `selector` fail as a node does when it is down. */
function failRead(rig: RevokeRig, selector: string): void {
  rig.beforeRequest = (method, params) => {
    const call = params[0] as { data?: string } | undefined
    if (method === "eth_call" && call?.data?.startsWith(selector)) {
      rig.fake.inject("eth_call", { error: { code: -32000, message: "internal error" } })
    }
  }
}

describe("what there is to revoke", () => {
  test("an allowance of 0 is nothing to revoke", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 0n } } })
    await expectRefused(rig, revokeArgs(), "invalid_argument", NO_APPROVAL)
  })

  test("an allowance of another spender, or from another owner, is not this one's", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, {
      allowances: { [HARDHAT_ADDRESS_0]: { [HARDHAT_ADDRESS_0]: 5n }, [HARDHAT_ADDRESS_1]: { [SPENDER]: 5n } },
    })
    await expectRefused(rig, revokeArgs(), "invalid_argument", NO_APPROVAL)
  })

  test("a collection with no operator approval", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc721(COLLECTION_ADDRESS, { interfaces: [ERC721_ID] })
    await expectRefused(rig, revokeArgs({ token: COLLECTION_ADDRESS }), "invalid_argument", NO_APPROVAL)
  })

  test("a token without decimals is never revoked as an ERC-20, whatever its allowance says", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, {
      decimals: "revert",
      allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n } },
    })
    await expectRefused(rig, revokeArgs(), "invalid_argument", NO_APPROVAL)
    expect(
      rig.fake.requestsOf("eth_call").some(([call]) => JSON.stringify(call).includes(ALLOWANCE_SELECTOR.slice(2))),
    ).toBe(false)
  })

  test("an address without code", async () => {
    await expectRefused(makeRevokeRig(), revokeArgs({ token: HARDHAT_ADDRESS_1 }), "invalid_argument", /no contract at/)
  })

  test("the spender is a 0x address, not a name", async () => {
    await expectRefused(
      makeRevokeRig(),
      revokeArgs({ spender: "uniswap.eth" }),
      "invalid_argument",
      /spender must be a 0x address/,
    )
  })
})

describe("a read that fails is not 'nothing to revoke'", () => {
  test("an allowance read that fails stops the call", async () => {
    const rig = rigWithAllowance()
    failRead(rig, ALLOWANCE_SELECTOR)
    const approval = await rig.approve(revokeArgs())
    expect(approval.refused).toMatchObject({ code: "upstream_error" })
    expect(approval.refused?.message).not.toMatch(NO_APPROVAL)
    await expect(rig.run(revokeArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("a decimals read that fails stops the call too", async () => {
    const rig = rigWithAllowance()
    failRead(rig, DECIMALS_SELECTOR)
    await expect(rig.run(revokeArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect(rig.broadcasts()).toHaveLength(0)
  })

  test("an operator read that fails stops the call", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc721(COLLECTION_ADDRESS, { operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]] })
    failRead(rig, "0xe985e9c5")
    await expect(rig.run(revokeArgs({ token: COLLECTION_ADDRESS }))).rejects.toMatchObject({ code: "upstream_error" })
    expect(rig.broadcasts()).toHaveLength(0)
  })
})

describe("refusals before anyone is asked", () => {
  test("the zero address as the spender", async () => {
    const rig = rigWithAllowance()
    rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [`0x${"0".repeat(40)}`]: 50n } } })
    await expectRefused(rig, revokeArgs({ spender: `0x${"0".repeat(40)}` }), "invalid_argument", /zero address/)
  })

  test("a wallet that cannot cover max_fee", async () => {
    const rig = rigWithAllowance()
    rig.fake.setBalance(HARDHAT_ADDRESS_0, 10n ** 14n)
    await expectRefused(rig, revokeArgs(), "invalid_argument", /holds 100000000000000 wei.*Give a smaller max_fee/)
  })

  test("a max_fee below what the network asks now", async () => {
    await expectRefused(
      rigWithAllowance(),
      revokeArgs({ max_fee: "1000" }),
      "invalid_argument",
      /max_fee 1000 wei is below the/,
    )
  })

  test("a sender with no key, before any request to the chain", async () => {
    const rig = rigWithAllowance()
    const approval = await rig.approve(revokeArgs({ account: "ghost" }))
    expect(approval.refused).toBeDefined()
    expect(rig.fake.requests).toHaveLength(0)
  })

  test("an earlier write the node still holds", async () => {
    const rig = rigWithAllowance()
    rig.fake.failSend({ transport: "timeout", accepted: true })
    rig.mineAtMs = undefined
    const first = await rig.run(revokeArgs())
    expect(first.outcome).toBe("pending")
    const approval = await rig.approve(revokeArgs())
    expect(approval.refused).toMatchObject({ code: "stale" })
    expect(approval.refused?.message).toContain(first.hash)
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("sends_per_hour counts a revoke like any other write", async () => {
    const rig = makeRevokeRig({ options: { sends_per_hour: 1 } })
    rig.fake.addErc20(TOKEN_ADDRESS, {
      allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n, [COLLECTION_ADDRESS]: 7n } },
    })
    expect((await rig.run(revokeArgs())).outcome).toBe("confirmed")
    const another = revokeArgs({ spender: COLLECTION_ADDRESS })
    expect((await rig.approve(another)).refused).toMatchObject({ code: "rate_limited" })
    await expect(rig.tool.execute(rig.tool.input.parse(another), rig.ctx)).rejects.toMatchObject({
      code: "rate_limited",
    })
    expect(rig.broadcasts()).toHaveLength(1)
  })
})

describe("a revoke whose approval no longer holds", () => {
  test("is stale when the transaction changed after the prompt", async () => {
    const rig = rigWithAllowance()
    const { pin } = await rig.approve(revokeArgs())
    rig.fake.addErc721(TOKEN_ADDRESS, { operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]] })
    await expect(checkPin(rig.tool, revokeArgs(), rig.ctx, pin)).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)
  })

  test("is stale under the lock when the call changed between the run's first look and its second", async () => {
    const rig = rigWithAllowance()
    let looks = 0
    rig.beforeRequest = (method) => {
      if (method === "eth_getCode" && ++looks === 2) {
        rig.fake.addErc721(TOKEN_ADDRESS, { operators: [[HARDHAT_ADDRESS_0, SPENDER_ADDRESS]] })
      }
    }
    await expect(rig.tool.execute(rig.tool.input.parse(revokeArgs()), rig.ctx)).rejects.toMatchObject({
      code: "stale",
    })
    expect(rig.broadcasts()).toHaveLength(0)
    expect(await rig.rows()).toEqual([])
  })

  test("an approval that was revoked meanwhile is refused as nothing to revoke when it runs", async () => {
    const rig = rigWithAllowance()
    expect((await rig.approve(revokeArgs())).refused).toBeUndefined()
    rig.fake.addErc20(TOKEN_ADDRESS, {})
    await expect(rig.invoke(revokeArgs())).rejects.toMatchObject({ code: "invalid_argument" })
    expect(rig.broadcasts()).toHaveLength(0)
  })
})
