import type { OptionSpec } from "./core"

/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "web3-tools",
  /** The command line the Hermes plugin calls. */
  cli: "web3-tools-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "web3",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "WEB3_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["evm", "solana", "wallet"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["evm", "solana", "wallet"] as readonly string[],
  /** The package's own settings, which the tools themselves read: each snake_case name and its type, with bounds when it needs them. */
  options: { state_dir: "path", sends_per_hour: { type: "number", integer: true, min: 1 } } as Readonly<
    Record<string, OptionSpec>
  >,
  /** The environment variables the tools read besides the settings, which Codex forwards to the server after them. */
  toolVariables: ["ALCHEMY_API_KEY", "HELIUS_API_KEY"] as readonly string[],
} as const
