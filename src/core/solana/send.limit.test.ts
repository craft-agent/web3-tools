import { afterEach, describe, expect, test } from "bun:test"
import { cleanRigs, makeRig, solArgs } from "./send.testing"

afterEach(cleanRigs)

describe("sends_per_hour", () => {
  test("a send past the limit is refused before anyone is asked, with when to try again", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")

    const approval = await rig.approve(solArgs())
    expect(approval.refused).toMatchObject({ code: "rate_limited", details: { retry_after_s: 3600 } })
    expect(approval.resources).toBeUndefined()
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
    expect(await rig.rows()).toHaveLength(1)
  })

  test("a send that may be out counts, as one that landed does", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    rig.fake.failSend({ transport: "http500", accepted: false })
    expect((await rig.run(solArgs())).outcome).toBe("pending")
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("a send the cluster refused does not count", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    rig.fake.failSend({ reject: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } })
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "upstream_error" })
    rig.fake.advance(1)
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
  })

  test("the room under the limit is used", async () => {
    const rig = makeRig({ options: { sends_per_hour: 2 } })
    await rig.run(solArgs())
    expect((await rig.run(solArgs())).outcome).toBe("confirmed")
    await expect(rig.run(solArgs())).rejects.toMatchObject({ code: "rate_limited" })
  })

  test("without the setting there is no limit", async () => {
    const rig = makeRig()
    for (let send = 0; send < 3; send++) await rig.run(solArgs())
    expect(await rig.rows()).toHaveLength(3)
  })

  test("the limit is checked again under the ledger's lock, where a run without the gate's answer meets it", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    await rig.run(solArgs())
    const parsed = rig.tool.input.parse(solArgs())
    await expect(rig.tool.execute(parsed, rig.ctx)).rejects.toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
  })
})
