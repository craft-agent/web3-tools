import { afterEach, describe, expect, test } from "bun:test"
import { cleanRigs, makeRig, nativeArgs } from "./send.testing"

afterEach(cleanRigs)

describe("sends_per_hour", () => {
  test("a send past the limit is refused before anyone is asked, with when to try again", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")

    const approval = await rig.approve(nativeArgs())
    expect(approval.refused).toMatchObject({ code: "rate_limited", details: { retry_after_s: 3600 } })
    expect(approval.resources).toBeUndefined()
    await expect(rig.run(nativeArgs())).rejects.toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
    expect(await rig.rows()).toHaveLength(1)
  })

  test("a send that may be out counts, as one that landed does", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    rig.fake.failSend({ transport: "http500", accepted: false })
    expect((await rig.run(nativeArgs())).outcome).toBe("pending")
    await expect(rig.run(nativeArgs())).rejects.toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
  })

  test("a send the network refused does not count", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    rig.fake.failSend({ reject: { code: -32000, message: "txpool is full" } })
    await expect(rig.run(nativeArgs())).rejects.toMatchObject({ code: "upstream_error" })
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")
  })

  test("the room under the limit is used", async () => {
    const rig = makeRig({ options: { sends_per_hour: 2 } })
    await rig.run(nativeArgs())
    expect((await rig.run(nativeArgs())).outcome).toBe("confirmed")
    await expect(rig.run(nativeArgs())).rejects.toMatchObject({ code: "rate_limited" })
  })

  test("without the setting there is no limit", async () => {
    const rig = makeRig()
    for (let send = 0; send < 3; send++) await rig.run(nativeArgs())
    expect(await rig.rows()).toHaveLength(3)
  })

  test("the limit is checked again under the ledger's lock, where a run without the gate's answer meets it", async () => {
    const rig = makeRig({ options: { sends_per_hour: 1 } })
    await rig.run(nativeArgs())
    const parsed = rig.tool.input.parse(nativeArgs())
    await expect(rig.tool.execute(parsed, rig.ctx)).rejects.toMatchObject({ code: "rate_limited" })
    expect(rig.broadcasts()).toHaveLength(1)
  })
})
