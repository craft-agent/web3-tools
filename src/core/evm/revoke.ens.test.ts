import { afterEach, describe, expect, test } from "bun:test"
import { checkPin } from "../../entry/pin"
import { makeRevokeRig, revokeArgs, SPENDER_ADDRESS, type RevokeRig } from "./revoke.testing"
import { cleanRigs, expectRefused, TOKEN_ADDRESS } from "./send.testing"
import { HARDHAT_ADDRESS_0 } from "./testing.sign"

afterEach(cleanRigs)

const NAME = "uniswap.eth"
const SPENDER = SPENDER_ADDRESS.toLowerCase()
const OTHER_SPENDER = "0x1111111111111111111111111111111111111111"

/** A rig whose token gives `SPENDER_ADDRESS` and `OTHER_SPENDER` an allowance from `main`, and in which `NAME` points to the first. */
function rigWithName(): RevokeRig {
  const rig = makeRevokeRig()
  rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n, [OTHER_SPENDER]: 5n } } })
  rig.fake.addEnsName(NAME, SPENDER_ADDRESS)
  return rig
}

describe("a revoke of a spender given by ENS name", () => {
  test("revokes the address the name resolves to, and the prompt shows the name beside it", async () => {
    const rig = rigWithName()
    const args = revokeArgs({ spender: NAME })
    const approval = await rig.approve(args)
    expect(approval.resources).toEqual([`from:${HARDHAT_ADDRESS_0}`, `spender:${SPENDER_ADDRESS}`])
    expect(approval.description?.facts.slice(0, 2)).toEqual([
      { label: "Spender", value: SPENDER_ADDRESS },
      { label: "ENS name", value: `${NAME} resolved to ${SPENDER_ADDRESS}` },
    ])

    const result = await rig.run(args)
    expect(result).toMatchObject({ outcome: "confirmed", spender: SPENDER_ADDRESS, ens: NAME, revoked: "allowance" })
    expect((await rig.rows())[0]).toMatchObject({ recipient: SPENDER_ADDRESS, kind: "revoke_erc20" })
  })

  test("a name with no address, or one that needs an off-chain lookup, is refused before anyone is asked", async () => {
    const rig = rigWithName()
    rig.fake.addOffchainEnsName("cb.id")
    await expectRefused(rig, revokeArgs({ spender: "nobody.eth" }), "invalid_argument", /has no address on ENS/)
    await expectRefused(rig, revokeArgs({ spender: "cb.id" }), "invalid_argument", /resolves off-chain \(EIP-3668\)/)
  })

  test("a name that resolves elsewhere after the prompt is stale", async () => {
    const rig = rigWithName()
    const args = revokeArgs({ spender: NAME })
    const { pin } = await rig.approve(args)
    rig.fake.addEnsName(NAME, OTHER_SPENDER)
    await expect(checkPin(rig.tool, args, rig.ctx, pin)).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(0)
  })
})
