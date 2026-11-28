import { describe, expect, test } from "bun:test"
import { toolError } from "../rpc/client.fixtures"
import { metadataFacts } from "./reads.token"
import { testAddress } from "./testing"
import { FakeSolanaCluster } from "./testing.cluster"
import { TOKEN_STANDARDS } from "./token-rules"

const MINT = testAddress(3)

describe("metadataFacts", () => {
  test("reads the symbol and the token standard of the mint's Token Metadata account", async () => {
    const cluster = new FakeSolanaCluster().addMint(MINT)
    cluster.addMetadata({ mint: MINT, symbol: "TKN", tokenStandard: TOKEN_STANDARDS.fungible })
    expect(await metadataFacts(cluster.client(), MINT)).toEqual({
      symbol: "TKN",
      tokenStandard: TOKEN_STANDARDS.fungible,
    })
  })

  test("is null for a mint with no metadata account, and for an address another program holds there", async () => {
    const cluster = new FakeSolanaCluster().addMint(MINT)
    expect(await metadataFacts(cluster.client(), MINT)).toBeNull()
    cluster.setAccount(cluster.addMetadata({ mint: MINT, symbol: "X", tokenStandard: null }), { lamports: 1_000_000n })
    expect(await metadataFacts(cluster.client(), MINT)).toBeNull()
  })

  test("an account of Token Metadata whose data is cut short is upstream_error", async () => {
    const cluster = new FakeSolanaCluster().addMint(MINT)
    const address = cluster.addMetadata({ mint: MINT, symbol: "X", tokenStandard: null })
    cluster.setAccount(address, { owner: cluster.entryAt(address)!.owner, data: new Uint8Array([4, 1, 2]) })
    expect((await toolError(metadataFacts(cluster.client(), MINT))).code).toBe("upstream_error")
  })
})
