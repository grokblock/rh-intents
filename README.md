# Grok Block

**Agents act on chain without owning the key.**

<img src="web/assets/grokblock.jpg" alt="Grok Block" width="120">

Grok Chain's model — an agent that spends without ever holding a wallet — rebuilt
for Robinhood Chain.

You keep the key. The agent gets a *mandate* instead — the financial term for
authority to act on someone's behalf within defined limits, which is exactly what
this issues: one asset, a spending cap, an expiry, and a list of approved payees.

**On "trading":** what works today is execution under a mandate — moving an
approved asset to an approved payee without holding a key. Swaps are not built.
The chain's router is at `0x8876789976decbfcbbbe364623c63652db8c0904` (verified
deployed), but it is a *modified* UniversalRouter fork with an extra
`minHopPriceX36` field, so standard Uniswap SDK calldata reverts against it, and
look-alike routers exist on the chain. Until a swap is simulated through a
mandate, this is not described as trading.

Grok Chain stays on Solana. This is not a bridge, a fork, or a port of its code.
None of that code runs here: Robinhood Chain is EVM, so PDAs, Anchor and CPI have
no equivalent. What carries across is the *shape* — a human funds an account and
issues a capped, expiring, revocable permission; an agent signs against it and
holds nothing; a relayer pays the gas.

Independent project. Not affiliated with Robinhood Markets, Inc. or xAI.

Live: **https://mandate-lake.vercel.app** &middot; source in [`web/`](web/), a standalone file with no build step.

## The finding that shapes everything

Most of what Grok Chain had to build by hand already exists here as a standard.

Robinhood Chain is an **Arbitrum Nitro** chain (mainnet `4663`, testnet `46630`)
and all three ERC-4337 EntryPoints are deployed, along with CREATE2, Multicall3
and Permit2. Verified, not assumed — `scripts/probe.mjs` re-checks every address.

ERC-4337 is account abstraction: accounts that are contracts rather than
keypairs, with their own validation rules. It is the same problem Grok Chain
solved from scratch, solved generically. It even uses the same word for the same
component.

| Grok Chain (Solana) | Here (EVM) | Build? |
| --- | --- | --- |
| `GrokAccount` PDA | ERC-4337 smart account | no — standard |
| `SpendVault` PDA | the smart account holds funds directly | no |
| `Paymaster` PDA | ERC-4337 Paymaster — same name, same job | no — standard |
| relayer | bundler, or our own `handleOps` caller | no |
| INTENTS router | EntryPoint | no — standard |
| **`Grant` PDA — cap, expiry, allowlist** | **session-key permission module** | **yes — this is the work** |
| `check_grant` CPI | `validateUserOp` hook on that module | yes |
| `pay_token` | ERC-20 transfer authorised by the module | yes (small) |
| merchant allowlist | allowlist inside the module | yes (small) |
| subscriptions | same period counter, in storage | yes (small) |

So the project is **one contract and its client**, not a chain platform. Grok
Chain took two programs and a size fight; the equivalent here is a permission
module of a few hundred lines.

## What gets better

**Nothing has to be cut.** Grok Chain's payments deploy was gated on a 645,048
byte allocation, which is why the pump trade instructions were removed. EVM
contract size limits are per-contract and modules can be split, so features
compete for design attention rather than for bytes.

**The paymaster is somebody else's problem.** Sponsored gas is a solved,
standardised piece of infrastructure here instead of a PDA we maintain.

**Bundlers are optional** — and in the end not used at all. See below.

**USDG has 6 decimals**, same as USDC. Raw-unit spending caps carry over with
their meaning intact — on mainnet. Testnet has neither USDG nor WETH deployed,
so a rehearsal there needs a mock token, and a mock must never be labelled USDG.

## Why not ERC-4337, after all

The table above says the smart account and EntryPoint come free. Writing the
thing changed the answer, so here is the correction rather than a quiet edit.

Account abstraction is right when an agent needs a general account that can do
arbitrary things under policy. That is not this. The agent needs exactly one
capability — move one approved asset to an approved payee, up to a cap — and a
purpose-built vault expresses that in a fraction of the surface a 4337 account
plus a custom validator module would take. Less surface is the whole security
argument, so it wins.

`payWithSig` gives the gasless property directly: the agent signs an EIP-712
intent, anyone relays it, the relayer pays gas. No bundler, no EntryPoint, no
paymaster deposit. A 4337 wrapper can sit on top later; the reverse is not true.

## What gets harder, and must not be waved through

**Reentrancy.** Solana's account model made this mostly a non-issue; Grok Chain
never had to think about it. Here, any external call from the module is a
re-entry point. Checks-effects-interactions is not optional, and the metering has
to update before the transfer, never after.

**Approvals are a standing grant.** Solana moves tokens with an owner signature
per transfer. ERC-20 uses `approve`, and an unlimited approval is a permanent
capability that outlives the session key entirely — it would quietly undo the
whole point. The module must move funds itself, never hand out an allowance it
does not control.

**Nothing validates the account list for us.** Grok Chain's `remaining_accounts`
were re-derived and checked on chain, and that check caught real bugs. There is
no analogue, so wherever the client supplies addresses the contract has to
re-derive or constrain them itself.

**One asset per grant, still.** Grok Chain's cap meters a single `u64` with no
notion of asset, so a cap only means something while an agent spends one
denomination. That reasoning is not Solana-specific and applies here unchanged:
one asset per session key, or the cap stops meaning anything.

## Not carried over

`pump_create` and the pump trade adapters are pump.fun-specific and pump.fun is
Solana-only. If a launchpad matters here it is a different integration against
whatever this chain has, not a port.

## Status

Nothing is deployed. Nothing is written beyond the verified chain facts.

- [x] Chain identified and every address verified on chain
- [x] Architecture mapped against ERC-4337
- [x] `GrantVault` — the permission module. 6,376 bytes, **25.9% of the EIP-170 limit**
      (the Solana equivalent was fighting for room inside 645,048)
- [x] 50 tests against a real in-process EVM at chain id 4663, including that the
      client and contract agree on the EIP-712 domain (they are written by hand in
      two languages, and a mismatch fails every payment with nothing to point at)
- [x] Client and CLI — key paths not secrets, `--plan` on everything that spends
- [x] Subscriptions — on-chain period counter, 1-day minimum, no backfill
- [ ] Testnet deployment on `46630` — **blocked: no reachable faucet.** A fresh
      wallet reads 0 wei and the public endpoints 429 or need a key. This is the
      only thing outstanding; see `docs/DEPLOY.md` — needs a mock 6-decimal ERC-20 first: USDG
      does not exist there (both mainnet token addresses return no code on testnet)
- [ ] One real USDG payment on mainnet

## Using it

```bash
npm run build && npm test
node src/cli.mjs                  # commands
node src/cli.mjs status --agent 0x…
```

Three key files, three roles: the owner holds the money, the agent signs and
holds nothing, the relayer pays gas and can authorise nothing. Everything that
spends takes `--plan` and will tell you what it would do without doing it.

Full walkthrough in [docs/DEPLOY.md](docs/DEPLOY.md), including how to stop an
agent three different ways and what to check before trusting a deployed vault.

## Verify before trusting

```bash
node scripts/probe.mjs            # mainnet
node scripts/probe.mjs testnet
```

Exits non-zero if any address in `chain.json` no longer has code, or if a token's
decimals moved. Every claim in this README is one of those checks.
