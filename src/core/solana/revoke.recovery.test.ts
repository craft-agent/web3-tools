import { afterEach, describe, expect, test } from "bun:test"
import { invoke } from "../tool"
import { makeRevokeRig, revokeArgs, type RevokeRig } from "./revoke.testing"
import { defineSolanaSend } from "./send"
import { BOB, cleanRigs, MINT, solArgs } from "./send.testing"
import { decodeTransaction } from "./testing.cluster.tx"

afterEach(cleanRigs)

/** The blocks after which the blockhash of a transaction made at the fake's first block has expired. */
const BLOCKHASH_EXPIRED = 151

/** A send tool on the same cluster, whose wait mines at once: the next write of the wallet, whichever tool made the first. */
function sendOn(rig: RevokeRig) {
  return defineSolanaSend({ fetch: rig.fake.fetch, env: {}, sleep: async () => void rig.fake.mine() })
}

describe("a broadcast that never reached the cluster, across tools", () => {
  test("a lost revoke holds the next write, a send, as stale until its blockhash expires, and is then rejected", async () => {
    const rig = makeRevokeRig()
    rig.fake.failSend({ transport: "timeout", accepted: false })
    rig.mineAtMs = undefined
    const lost = await rig.run(revokeArgs())
    expect(lost.outcome).toBe("pending")
    expect((await rig.rows())[0]).toMatchObject({ outcome: "unknown", kind: "revoke", token: MINT })

    const send = sendOn(rig)
    await expect(invoke(send, solArgs({ to: BOB }), rig.ctx)).rejects.toMatchObject({ code: "stale" })
    expect(rig.broadcasts()).toHaveLength(1)

    rig.fake.advance(BLOCKHASH_EXPIRED)
    const second = await invoke(send, solArgs({ to: BOB }), rig.ctx)
    expect(second.outcome).toBe("confirmed")
    expect(second.signature).not.toBe(lost.signature)
    expect(rig.broadcasts().map((raw) => decodeTransaction(raw).signature)).toEqual([lost.signature, second.signature])
    expect(rig.fake.statusOf(lost.signature)).toBeUndefined()
    expect((await rig.rows()).map((row) => [row.kind, row.outcome])).toEqual([
      ["revoke", "rejected"],
      ["sol", "confirmed"],
    ])
  })
})
