import { base64 } from "@scure/base"
import type { MintFacts, TokenAccountFacts, TokenExtension } from "./reads.token"

/**
 * The first 328 bytes of the Token Metadata account of USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v), as a mainnet
 * node answered `getAccountInfo` with base64: everything through the edition nonce (`Some(252)`) and the token
 * standard (`None`), which is where the reader stops, and a zero byte after it. The account is 679 bytes; the rest is zeros.
 */
export const USDC_METADATA_PREFIX = base64.decode(
  [
    "BBzjWe1aAS4E+hQrnHUaHF6Hz9CgFhuchf/TG3jN/Nj2xvp6877brTo9ZfNqq8l0MbG75MLS",
    "9uDkfKYCA0UvXWEgAAAAVVNEIENvaW4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAVVNE",
    "QwAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    "AfwAAA==",
  ].join(""),
)

/**
 * The first 328 bytes of the Token Metadata account of Bonk (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263), as a
 * mainnet node answered `getAccountInfo` with base64: its edition nonce is `Some(255)` and its token standard
 * `Some(2)`, `Fungible`.
 */
export const BONK_METADATA_PREFIX = base64.decode(
  [
    "BHlZUWfaSAxa4TRFAdIRt3NjQOP73wDs3mO2TciKzC8cvAfFbmCtPT8Xc4LqxlSPuh/TLP2Q",
    "ygKz58+hhf3Oc5ggAAAAQm9uawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAQm9u",
    "awAAAAAAAMgAAABodHRwczovL2Fyd2VhdmUubmV0L1FQQzZGWWRVbi0zVjh5dEZOdW9DUzg1",
    "UzJ0SEF1aURibGg2dTNDSVpMc3cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEB",
    "Af8BAg==",
  ].join(""),
)

/** A mint of the given decimals and supply, with extensions. */
export function mintWith(extensions: TokenExtension[] = [], decimals = 6, supply = 1_000n): MintFacts {
  return { program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", decimals, supply, freezeAuthority: null, extensions }
}

/** A token account with extensions, initialized unless `state` says. */
export function accountWith(
  extensions: TokenExtension[] = [],
  state: TokenAccountFacts["state"] = "initialized",
): TokenAccountFacts {
  return { mint: "m", owner: "o", amount: 10n, delegate: null, delegatedAmount: 0n, state, extensions }
}

/** An extension by name, with its state. */
export function extension(name: string, state: Record<string, unknown> = {}): TokenExtension {
  return { name, state }
}
