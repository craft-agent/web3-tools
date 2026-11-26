import { checkLabel, DEFAULT_LABEL } from "../core/signer/labels"
import { createWallet, importWallet, refuseUnwritableWallet } from "../core/signer/setup"
import type { SetupResult } from "../core/signer/setup"
import { createToolRuntime } from "../entry/runtime"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, STATE_DIR_FLAG, usageError } from "./command-args"
import { EXIT_OK, throwIfCancelled } from "./command-io"
import type { CommandIo } from "./command-io"

const ACCOUNT_FLAG = "--account"
const WORDS_FLAG = "--words"

/** The word count of a new phrase when `--words` is not given. */
const DEFAULT_WORDS = 24

const USAGE_IMPORT = `Usage: wallet import [${ACCOUNT_FLAG} <label>] [${STATE_DIR_FLAG} <path>]; the key is read from standard input, never from an argument.`
const USAGE_CREATE = `Usage: wallet create [${ACCOUNT_FLAG} <label>] [${WORDS_FLAG} 12|24] [${STATE_DIR_FLAG} <path>].`
const USAGE = 'Use "wallet import" or "wallet create".'
const KEY_NEEDED = "Give the key on standard input."

/** What a key is called in the report of its import. */
const KEY_NAMES = { evm: "an EVM private key", solana: "a Solana keypair" }

/** What `wallet` needs: the command's surroundings and a way to read the key from standard input. */
export type WalletIo = CommandIo & { readStdin(): Promise<string> }

type WalletCommand = { label: string; stateDir: string; words: 12 | 24 }

/** The label of `--account`; a bad one is refused without quoting it, since it may have been a pasted key. */
function commandLabel(value: string | undefined): string {
  try {
    return checkLabel(value ?? DEFAULT_LABEL)
  } catch {
    throw usageError(
      `Invalid label: use 1 to 24 lowercase letters, digits and "_", starting and ending with a letter or digit.`,
    )
  }
}

function commandWords(value: string | undefined): 12 | 24 {
  if (value === undefined) return DEFAULT_WORDS
  if (value !== "12" && value !== "24") throw usageError(`Option ${WORDS_FLAG} takes 12 or 24.`)
  return Number(value) as 12 | 24
}

/**
 * Reads the arguments after the subcommand. None of them is ever repeated in
 * an error, since a key pasted in the wrong place must not reach the screen.
 */
function parseWalletCommand(args: string[], io: CommandIo, create: boolean): WalletCommand {
  const values = create ? [ACCOUNT_FLAG, WORDS_FLAG, STATE_DIR_FLAG] : [ACCOUNT_FLAG, STATE_DIR_FLAG]
  const parsed = parseFlagArgs(args, { values })
  if (parsed.rest.length > 0) throw usageError(create ? USAGE_CREATE : USAGE_IMPORT)
  const stateDirFlag = parsed.values[STATE_DIR_FLAG]
  const { stateDir } = parseCommandStateDir(stateDirFlag === undefined ? [] : [`${STATE_DIR_FLAG}=${stateDirFlag}`], io)
  return { label: commandLabel(parsed.values[ACCOUNT_FLAG]), stateDir, words: commandWords(parsed.values[WORDS_FLAG]) }
}

function keyName({ kind, words }: SetupResult): string {
  return kind === "phrase" ? `a seed phrase of ${words} words` : KEY_NAMES[kind]
}

function accountLines({ evm, solana }: SetupResult): string[] {
  return [
    ...(evm === undefined ? [] : [`EVM account 0: ${evm}`]),
    ...(solana === undefined ? [] : [`Solana account 0: ${solana}`]),
  ]
}

async function runImport(args: string[], io: WalletIo): Promise<number> {
  const { label, stateDir } = parseWalletCommand(args, io, false)
  const runtime = createToolRuntime({ profile: io.profile, env: io.env })
  throwIfCancelled(io.signal)
  await refuseUnwritableWallet(label, runtime, stateDir)

  const text = await io.readStdin()
  if (text.trim() === "") throw usageError(KEY_NEEDED)
  throwIfCancelled(io.signal)
  const result = await importWallet(label, text, runtime, stateDir)
  io.stdout(
    [
      `Imported wallet "${label}" into ${result.file} (mode 600): ${keyName(result)}.`,
      ...accountLines(result),
      "Nothing was sent to a chain.",
    ].join("\n") + "\n",
  )
  return EXIT_OK
}

async function runCreate(args: string[], io: WalletIo): Promise<number> {
  const { label, stateDir, words } = parseWalletCommand(args, io, true)
  const runtime = createToolRuntime({ profile: io.profile, env: io.env })
  throwIfCancelled(io.signal)
  const result = await createWallet(label, words, runtime, stateDir)
  io.stdout(
    [
      `Created wallet "${label}" in ${result.file} (mode 600): a new ${words}-word seed phrase no one has seen.`,
      ...accountLines(result),
      "Back the phrase up before funding it: it exists only in that file. Read it yourself, never through an agent.",
    ].join("\n") + "\n",
  )
  return EXIT_OK
}

/**
 * The `wallet` commands, for a person: `import` reads a key from standard
 * input (hidden on a terminal) and `create` makes a new seed phrase no one
 * sees, each into the label's own file, create-only. Both take
 * `--account <label>` (default `default`) and `--state-dir <path>`, `create`
 * also `--words 12|24` (default 24), and both refuse while the label's
 * variable is set, `import` before it asks for the key. A key is never an
 * argument, never printed and never in an error: a command line that holds
 * something unknown is refused without repeating it. Prints the address of
 * account 0 on each family the key opens, nothing is sent to a chain. Resolves
 * to the exit code: 0, 1 after a failure, 2 for a mistake in the command line.
 */
export async function runWalletCommand(argv: string[], io: WalletIo): Promise<number> {
  const [subcommand, ...args] = argv
  try {
    if (subcommand === "import") return await runImport(args, io)
    if (subcommand === "create") return await runCreate(args, io)
    throw usageError(USAGE)
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto", abortMessage: "Cancelled." })
  }
}
