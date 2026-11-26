---
name: web3-wallet
description: "Use when seeing which wallets the tools can sign with and their addresses, or explaining to a person how to set one up."
metadata:
  toolset: wallet
---

# Wallets

| Tool               | Does                                                     | Writes |
| ------------------ | -------------------------------------------------------- | ------ |
| `web3_wallet_read` | `list`: wallets and first addresses; `accounts`: a range | no     |

Both methods compute addresses from keys without a request and never show keys.
Reading any other address needs no wallet.

## Labels and accounts

A label is 1–24 lowercase letters, digits and `_`, starting and ending with a
letter or digit; the default label is `default`. Sender `account` is a label
or `label#index`, index 0–100 (0 when omitted). Left out, it selects the only
label; several labels require a choice. The wallet read's `accounts` method
takes a label alone, with `from` (default 0) and `count` (default 10).
A lone key returns one address with `index: null`, ignoring the range.

`WEB3_TOOLS_WALLET_<LABEL>` wins; otherwise the key comes from
`<state_dir>/accounts/<label>/wallet`, a regular file with mode 600.
A phrase opens both families; an EVM key or Solana keypair opens only its own.
Phrase paths match MetaMask (`m/44'/60'/0'/0/<index>`) and Phantom
(`m/44'/501'/<index>'/0'`), so the same words show the same accounts.

## Setup is for a person

- `web3-tools-cli wallet import [--account <label>]`: reads a key on standard
  input, hidden on a terminal.
- `web3-tools-cli wallet create [--account <label>] [--words 12|24]`: makes a
  new phrase and writes it to the wallet file without displaying it.

Both commands are create-only: they refuse an existing wallet or a set variable.
The file is the only copy of a created phrase. Tell the person to read it
themselves, never through an agent, and back it up securely before funding it.
There is no remove command: delete the file by hand only after backing up the phrase.

An agent never asks for, reads, prints or stores a phrase or key, never runs
these commands on the person's behalf with a key in the command, and never
opens the wallet file.

## Problems

`list` keeps an unreadable wallet as a `problem` entry without addresses.
Relay its code and message to the person: for `forbidden`, have them check
ownership, remove links and fix the file mode with `chmod 600`; for an invalid
or unreadable key, have them check their variable or file privately.
Never ask them to paste its contents.
