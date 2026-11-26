import { lstat, readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { ToolError } from "../errors"
import type { ToolRuntime } from "../runtime"

/** The label used when none is given. */
export const DEFAULT_LABEL = "default"

/** 1 to 24 lowercase letters, digits and `_`, starting and ending with a letter or digit. */
export const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9_]{0,22}[a-z0-9])?$/

/** Maximum character length of a bad label shown in error messages. */
const MAX_BAD_LABEL_PREVIEW = 40

/** The directory of the state root that holds one directory per label. */
const ACCOUNTS_DIR = "accounts"

/** The name of a label's file in its directory. */
const WALLET_FILE = "wallet"

/** Where a label's key is kept: a variable, or the label's file. */
export type KeySource = "variable" | "file"

/** The state root and the paths of one label's wallet; every path is inside `root`. */
export type WalletPaths = {
  root: string
  /** `<root>/accounts`: one directory per label. */
  accounts: string
  /** `<root>/accounts/<label>` */
  dir: string
  /** `<root>/accounts/<label>/wallet`: the key, when it is not in the environment. */
  file: string
}

/** A label that has a wallet, and where its key comes from. */
export type LabelEntry = { label: string; source: KeySource }

function quoteBadLabel(value: string): string {
  const truncated = value.length > MAX_BAD_LABEL_PREVIEW ? `${value.slice(0, MAX_BAD_LABEL_PREVIEW)}…` : value
  return JSON.stringify(truncated)
}

/** Whether `value` is a valid label name. */
export function isLabel(value: string): boolean {
  return typeof value === "string" && LABEL_PATTERN.test(value)
}

/** Returns the label, or throws `invalid_argument` stating the rule. */
export function checkLabel(value: string): string {
  if (!isLabel(value)) {
    throw new ToolError(
      "invalid_argument",
      `Invalid label ${quoteBadLabel(value)}: a label must be 1 to 24 lowercase letters, digits and "_", starting and ending with a letter or digit.`,
    )
  }
  return value
}

/** The name of the variable that holds a label's key. */
export function walletVariable(label: string, envPrefix: string): string {
  return `${envPrefix}_WALLET_${label.toUpperCase()}`
}

/** Resolves the paths of `label`'s wallet under `stateDir`; throws `internal_error` for a relative one. */
export function walletPaths(stateDir: string, label: string): WalletPaths {
  if (!isAbsolute(stateDir)) {
    throw new ToolError("internal_error", `State directory must be absolute; got ${JSON.stringify(stateDir)}.`)
  }
  const accounts = join(stateDir, ACCOUNTS_DIR)
  const dir = join(accounts, label)
  return { root: stateDir, accounts, dir, file: join(dir, WALLET_FILE) }
}

/** The system error code of `error` (`ENOENT`), when it has one. */
export function errnoCode(error: unknown): string | undefined {
  const code = error instanceof Error && "code" in error ? error.code : undefined
  return typeof code === "string" ? code : undefined
}

/** Whether `error` says the path, or a directory above it, does not exist. */
function isMissingPath(error: unknown): boolean {
  const code = errnoCode(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

function variableLabels(runtime: ToolRuntime): string[] {
  const prefix = `${runtime.envPrefix}_WALLET_`
  const labels: string[] = []
  for (const [name, value] of Object.entries(runtime.env)) {
    if (value === undefined || !name.startsWith(prefix)) continue
    const label = name.slice(prefix.length).toLowerCase()
    // A name in another case is a label's variable only when it is the one `walletVariable` builds.
    if (isLabel(label) && walletVariable(label, runtime.envPrefix) === name) labels.push(label)
  }
  return labels
}

async function hasWalletEntry(accounts: string, label: string): Promise<boolean> {
  try {
    await lstat(join(accounts, label, WALLET_FILE))
    return true
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

async function fileLabels(accounts: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(accounts)
  } catch (error) {
    if (isMissingPath(error)) return []
    throw error
  }
  const present = await Promise.all(names.map(async (name) => isLabel(name) && (await hasWalletEntry(accounts, name))))
  return names.filter((_, index) => present[index])
}

/**
 * The labels that have a wallet, sorted and without duplicates: every label
 * whose variable is defined (even empty) and every directory of `accounts/`
 * named like a label that holds an entry named `wallet`, of any type, so a
 * broken one is listed and reading it reports what is wrong. A label with both
 * is a `variable`, since that is what is read. A missing `accounts/` adds none.
 */
export async function listLabels(runtime: ToolRuntime, stateDir: string): Promise<LabelEntry[]> {
  const { accounts } = walletPaths(stateDir, DEFAULT_LABEL)
  const variables = new Set(variableLabels(runtime))
  const files = await fileLabels(accounts)
  const labels = [...new Set([...variables, ...files])].sort()
  return labels.map((label) => ({ label, source: variables.has(label) ? "variable" : "file" }))
}
