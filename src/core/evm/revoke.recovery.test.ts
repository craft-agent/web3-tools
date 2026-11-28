import { afterEach, describe, expect, test } from "bun:test"
import { invoke } from "../tool"
import { makeRevokeRig, revokeArgs, SPENDER_ADDRESS, type RevokeRig } from "./revoke.testing"
import { defineEvmSend } from "./send"
import { cleanRigs, hashOfRaw, nativeArgs, TOKEN_ADDRESS } from "./send.testing"
import { HARDHAT_ADDRESS_0, HARDHAT_ADDRESS_1 } from "./testing.sign"

afterEach(cleanRigs)

const SPENDER = SPENDER_ADDRESS.toLowerCase()

/** A send tool on the same node, whose wait mines at once: the next write of the wallet, whichever tool made the first. */
function sendOn(rig: RevokeRig) {
  return defineEvmSend({
    fetch: rig.fake.fetch,
    env: {},
    sleep: async () => void rig.fake.mine(),
  })
}

describe("a broadcast that never reached the node, across tools", () => {
  test("a lost revoke gives its nonce to the next write, a send, instead of being sent again", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n } } })
    rig.fake.failSend({ transport: "timeout", accepted: false })
    rig.mineAtMs = undefined
    const lost = await rig.run(revokeArgs())
    expect(lost.outcome).toBe("pending")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "unknown", nonce: "0", kind: "revoke_erc20" })

    const send = sendOn(rig)
    const second = await invoke(send, nativeArgs({ to: HARDHAT_ADDRESS_1 }), rig.ctx)

    expect(second.outcome).toBe("confirmed")
    expect(second.hash).not.toBe(lost.hash)
    expect(rig.fake.receiptOf(second.hash)?.tx.nonce).toBe(0n)
    expect(rig.fake.receiptOf(lost.hash)).toBeUndefined()
    const hashes = rig.broadcasts().map(hashOfRaw)
    expect(hashes).toEqual([lost.hash, second.hash])
    expect((await rig.rows()).map((row) => [row.kind, row.outcome, row.nonce])).toEqual([
      ["revoke_erc20", "unknown", "0"],
      ["native", "confirmed", "0"],
    ])
  })

  test("a lost send gives its nonce to the next write, a revoke, and the revoke lands", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n } } })
    const send = sendOn(rig)
    rig.fake.failSend({ transport: "http500", accepted: false })
    const lost = await invoke(send, nativeArgs({ to: HARDHAT_ADDRESS_1 }), rig.ctx)
    expect(lost.outcome).toBe("pending")

    const result = await rig.run(revokeArgs())

    expect(result.outcome).toBe("confirmed")
    expect(rig.fake.receiptOf(result.hash)?.tx.nonce).toBe(0n)
    expect(rig.broadcasts().map(hashOfRaw)).toEqual([lost.hash, result.hash])
    expect((await rig.rows()).map((row) => [row.kind, row.nonce])).toEqual([
      ["native", "0"],
      ["revoke_erc20", "0"],
    ])
  })

  test("a revoke the node refused is rejected, and the next write goes on with the same nonce", async () => {
    const rig = makeRevokeRig()
    rig.fake.addErc20(TOKEN_ADDRESS, { allowances: { [HARDHAT_ADDRESS_0]: { [SPENDER]: 50n } } })
    rig.fake.failSend({ reject: { code: -32000, message: "txpool is full" } })
    const error = await rig.run(revokeArgs()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "upstream_error", details: { ledger_row: (await rig.rows())[0]!.id } })
    expect((await rig.rows())[0]).toMatchObject({ outcome: "rejected" })
    expect((await rig.run(revokeArgs())).outcome).toBe("confirmed")
    expect((await rig.rows()).map((row) => [row.outcome, row.nonce])).toEqual([
      ["rejected", "0"],
      ["confirmed", "0"],
    ])
  })
})
