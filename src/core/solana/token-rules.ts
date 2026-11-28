import { ToolError } from "../errors"
import { promptSymbol } from "../symbol"
import { SOLANA_ADDRESS_BYTES } from "./address"
import type { MintFacts, TokenAccountFacts, TokenExtension } from "./reads.token"

/** What a Token Metadata account says that a send needs: its declared symbol and its token standard (`null` when it has none). */
export type MetadataFacts = { symbol: string; tokenStandard: number | null }

/** What a transfer would expose its sender to that the prompt must name. */
export type TransferFacts = { permanentDelegate: string | null }

/** Token Metadata's `TokenStandard`, by its number in the program's enum. */
export const TOKEN_STANDARDS = {
  nonFungible: 0,
  fungibleAsset: 1,
  fungible: 2,
  nonFungibleEdition: 3,
  programmableNonFungible: 4,
  programmableNonFungibleEdition: 5,
} as const

/** The `Key` that starts an initialized Token Metadata `Metadata` account, `MetadataV1`. */
export const METADATA_V1_KEY = 4

/** The bytes of a creator: its address, a `verified` flag and its share. */
const CREATOR_BYTES = SOLANA_ADDRESS_BYTES + 2

/** The longest extension name quoted in a refusal. */
const MAX_QUOTED_NAME = 40

/** Why each extension that changes or may stop a transfer is refused, by the name the node gives it. */
const REFUSED_EXTENSIONS: Readonly<Record<string, string>> = {
  transferFeeConfig: "takes a transfer fee, so the recipient would receive less than the amount sent",
  transferHook: "runs a program of the token's choosing on every transfer",
  transferHookAccount: "runs a program of the token's choosing on every transfer",
  nonTransferable: "cannot be transferred",
  nonTransferableAccount: "cannot be transferred",
  confidentialTransferMint: "has confidential transfers, which these tools do not handle",
  confidentialTransferAccount: "has confidential transfers, which these tools do not handle",
  confidentialTransferFeeConfig: "has confidential transfers, which these tools do not handle",
  confidentialTransferFeeAmount: "has confidential transfers, which these tools do not handle",
  confidentialMintBurn: "has confidential transfers, which these tools do not handle",
}

/**
 * The extensions that are display-only or harmless to a transfer, and those the rules below look into. `pausableAccount`
 * only marks an account of a pausable mint, whose `pausableConfig` decides.
 */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "metadataPointer",
  "tokenMetadata",
  "groupPointer",
  "groupMemberPointer",
  "tokenGroup",
  "tokenGroupMember",
  "interestBearingConfig",
  "scaledUiAmountConfig",
  "mintCloseAuthority",
  "immutableOwner",
  "transferFeeAmount",
  "cpiGuard",
  "pausableAccount",
  "defaultAccountState",
  "pausableConfig",
  "memoTransfer",
  "permanentDelegate",
])

function refuse(reason: string): ToolError {
  return new ToolError("invalid_argument", `This token cannot be sent: ${reason}.`)
}

function unknownExtension(name: string): ToolError {
  return refuse(`it has an extension these tools do not know (${JSON.stringify(name.slice(0, MAX_QUOTED_NAME))})`)
}

function unreadableState(name: string): ToolError {
  return refuse(`its ${name} extension has a state these tools cannot read`)
}

function findExtension(extensions: readonly TokenExtension[], name: string): TokenExtension | undefined {
  return extensions.find((extension) => extension.name === name)
}

/** Refuses an extension that is refused outright or that no rule knows; `passes` names refused ones that do nothing here. */
function checkKnown(extensions: readonly TokenExtension[], subject: string, passes: ReadonlySet<string>): void {
  for (const { name } of extensions) {
    if (passes.has(name)) continue
    const reason = Object.hasOwn(REFUSED_EXTENSIONS, name) ? REFUSED_EXTENSIONS[name] : undefined
    if (reason !== undefined) throw refuse(`${subject} ${reason}`)
    if (!ALLOWED_EXTENSIONS.has(name)) throw unknownExtension(name)
  }
}

/** Whether a transfer fee setting charges nothing: its basis points or its maximum are 0. */
function chargesNothing(fee: unknown): boolean {
  if (fee === null || typeof fee !== "object") return false
  const { transferFeeBasisPoints, maximumFee } = fee as Record<string, unknown>
  return transferFeeBasisPoints === 0 || maximumFee === 0
}

/**
 * The refused extensions of `mint` that change nothing as they stand: a transfer hook with no program, which runs
 * nothing, and a transfer fee whose current and scheduled settings both charge nothing. Either can be set later,
 * but a send is built again before it is signed, so one set after the prompt stops it.
 */
function idleExtensions(mint: MintFacts): ReadonlySet<string> {
  const idle = new Set<string>()
  const hook = findExtension(mint.extensions, "transferHook")
  if (hook !== undefined && hook.state.programId === null) {
    idle.add("transferHook")
    idle.add("transferHookAccount")
  }
  const fee = findExtension(mint.extensions, "transferFeeConfig")
  if (fee !== undefined && chargesNothing(fee.state.olderTransferFee) && chargesNothing(fee.state.newerTransferFee)) {
    idle.add("transferFeeConfig")
  }
  return idle
}

function checkMint(mint: MintFacts, destinationIsNew: boolean, idle: ReadonlySet<string>): string | null {
  checkKnown(mint.extensions, "the token", idle)
  const defaultState = findExtension(mint.extensions, "defaultAccountState")
  if (defaultState !== undefined) {
    const { accountState } = defaultState.state
    if (accountState !== "initialized" && accountState !== "frozen") throw unreadableState(defaultState.name)
    if (accountState === "frozen" && destinationIsNew) {
      throw refuse("its new token accounts start frozen, so the recipient could not move what it receives")
    }
  }
  const pausable = findExtension(mint.extensions, "pausableConfig")
  if (pausable !== undefined) {
    const { paused } = pausable.state
    if (typeof paused !== "boolean") throw unreadableState(pausable.name)
    if (paused) throw refuse("the token is paused")
  }
  const delegate = findExtension(mint.extensions, "permanentDelegate")?.state.delegate
  if (delegate === undefined || delegate === null) return null
  if (typeof delegate !== "string") throw unreadableState("permanentDelegate")
  return delegate
}

function checkAccount(account: TokenAccountFacts, subject: string, idle: ReadonlySet<string>): void {
  if (account.state === "frozen") throw refuse(`the ${subject} token account is frozen`)
  checkKnown(account.extensions, `the ${subject} token account`, idle)
}

function checkMemo(destination: TokenAccountFacts): void {
  const memo = findExtension(destination.extensions, "memoTransfer")
  if (memo === undefined) return
  const required = memo.state.requireIncomingTransferMemos
  if (typeof required !== "boolean") throw unreadableState(memo.name)
  if (required) throw refuse("the recipient's token account requires a memo with every incoming transfer")
}

/**
 * Whether a transfer of `mint` from `source` to `destination` (`null` when the send would create it) moves exactly
 * the amount asked, with no program of a stranger's running and nothing stuck: else `invalid_argument` with the
 * reason. Refused: a Token-2022 transfer fee, transfer hook, non-transferable mint, confidential transfers, new
 * accounts frozen by default (only when `destination` is new), a paused mint, a memo the destination requires, a
 * frozen source or destination, and any extension this does not know, so that a new one fails closed. Display-only
 * extensions pass, and so do a transfer hook with no program and a transfer fee that charges nothing. Returns the
 * mint's permanent delegate (`null` when there is none), who can move any holder's tokens and which the prompt must
 * name.
 */
export function checkTransferable(
  mint: MintFacts,
  source: TokenAccountFacts | null,
  destination: TokenAccountFacts | null,
): TransferFacts {
  const idle = idleExtensions(mint)
  const permanentDelegate = checkMint(mint, destination === null, idle)
  if (source !== null) checkAccount(source, "source", idle)
  if (destination !== null) {
    checkAccount(destination, "recipient's", idle)
    checkMemo(destination)
  }
  return { permanentDelegate }
}

/** The symbol a prompt may show for the token: the Token-2022 `tokenMetadata` extension's, else the Metaplex account's; `null` when there is none or it is not fit to show. */
export function tokenPromptSymbol(mint: MintFacts, metadata: MetadataFacts | null): string | null {
  const declared = findExtension(mint.extensions, "tokenMetadata")?.state.symbol
  return promptSymbol(typeof declared === "string" ? declared : (metadata?.symbol ?? null))
}

function malformed(): ToolError {
  return new ToolError("upstream_error", "The token's metadata account is malformed.")
}

/** Reads a Token Metadata account's fields front to back, as Borsh lays them out. */
class MetadataReader {
  position = 0

  constructor(private readonly bytes: Uint8Array) {}

  get atEnd(): boolean {
    return this.position === this.bytes.length
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.position) throw malformed()
    const taken = this.bytes.subarray(this.position, this.position + length)
    this.position += length
    return taken
  }

  u8(): number {
    return this.take(1)[0]
  }

  u16(): number {
    const bytes = this.take(2)
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true)
  }

  u32(): number {
    const bytes = this.take(4)
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
  }

  /** A Borsh string: a u32 length and that many bytes. */
  string(): string {
    return new TextDecoder().decode(this.take(this.u32()))
  }

  /** The tag of a Borsh `Option`: whether a value follows. */
  isSome(): boolean {
    const tag = this.u8()
    if (tag > 1) throw malformed()
    return tag === 1
  }
}

/**
 * The symbol and token standard in the Token Metadata `Metadata` account `data`. The fields are read in order: key
 * (`MetadataV1`), update authority, mint, name, symbol and URI as Borsh strings, seller fee, creators, primary sale,
 * is mutable, edition nonce and token standard, where it stops. An account made before the token standard existed
 * has no value for it (`null`), whether its data ends before the edition nonce, before the standard or has `None`
 * there; data that ends anywhere else, a tag that is not 0 or 1 or another key is `upstream_error`. The symbol is
 * text the creator chose, with its trailing NULs trimmed. The standard is returned as its number, which may be one
 * `TOKEN_STANDARDS` does not name.
 */
export function metadataTokenStandard(data: Uint8Array): MetadataFacts {
  const reader = new MetadataReader(data)
  if (reader.u8() !== METADATA_V1_KEY) throw malformed()
  reader.take(SOLANA_ADDRESS_BYTES * 2)
  reader.string()
  const symbol = reader.string().replace(/\0+$/, "")
  reader.string()
  reader.u16()
  if (reader.isSome()) reader.take(reader.u32() * CREATOR_BYTES)
  reader.take(2)
  if (reader.atEnd) return { symbol, tokenStandard: null }
  if (reader.isSome()) reader.u8()
  if (reader.atEnd) return { symbol, tokenStandard: null }
  return { symbol, tokenStandard: reader.isSome() ? reader.u8() : null }
}

/** Whether `metadata` declares a fungible standard (`Fungible` or `FungibleAsset`): the mint is a token, whatever its decimals and supply. */
export function isFungibleStandard(metadata: MetadataFacts | null): boolean {
  const standard = metadata?.tokenStandard ?? null
  return standard === TOKEN_STANDARDS.fungibleAsset || standard === TOKEN_STANDARDS.fungible
}

/**
 * Whether the mint is a plain NFT, one that moves with an ordinary token transfer: 0 decimals, a supply of 1 and a
 * token standard of `NonFungible` or `NonFungibleEdition`, or none (`metadata` is `null`, or the account predates the
 * field). A programmable NFT must move through Token Metadata's own instruction, a fungible token is sent as a token
 * and a standard these tools do not know is not guessed at: each is `invalid_argument`.
 */
export function checkPlainNft(mint: MintFacts, metadata: MetadataFacts | null): void {
  const standard = metadata?.tokenStandard ?? null
  if (isFungibleStandard(metadata)) {
    throw new ToolError("invalid_argument", "This is a fungible token, not an NFT; send it as a token.")
  }
  if (mint.decimals !== 0 || mint.supply !== 1n) {
    throw new ToolError(
      "invalid_argument",
      `This is not an NFT: a mint with ${mint.decimals} decimals and a supply of ${mint.supply} is not one; an NFT has 0 decimals and a supply of 1.`,
    )
  }
  if (
    standard === TOKEN_STANDARDS.programmableNonFungible ||
    standard === TOKEN_STANDARDS.programmableNonFungibleEdition
  ) {
    throw new ToolError(
      "invalid_argument",
      "This is a programmable NFT, which moves only through Token Metadata's own instruction; these tools do not send it.",
    )
  }
  const isPlain =
    standard === null || standard === TOKEN_STANDARDS.nonFungible || standard === TOKEN_STANDARDS.nonFungibleEdition
  if (!isPlain)
    throw new ToolError("invalid_argument", `This NFT has token standard ${standard}, which these tools do not know.`)
}
