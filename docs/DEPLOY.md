# Deploying

How to stand up your own vault, and what to check before you trust it.

A reference vault already runs on mainnet at
`0x58B5B1800F52A494a7CEDB5b09ce97AAd41b496A`. Deploying your own costs about
0.0015 native and takes one command.

## A note on testnet

Testnet `46630` has no faucet reachable from here — a fresh wallet reads `0 wei`
— and **no USDG**: both mainnet token addresses return no code there. A rehearsal
would need `MockToken` deployed first, and a mock must never be labelled USDG
anywhere. Everything below therefore assumes mainnet, where the amounts are small
but real.

## Keys

Three roles, three files. The split is the security model, not a convenience.

| Key | Holds | Can |
| --- | --- | --- |
| `OWNER_KEY` | the money | issue grants, approve payees, withdraw |
| `AGENT_KEY` | nothing | sign payment intents |
| `RELAYER_KEY` | gas only | submit transactions, authorise nothing |

Generate them, then never pass one as an argument — every command reads a path.

```bash
mkdir -p keys && chmod 700 keys
node -e 'const {Wallet}=require("ethers");for(const r of ["owner","agent","relayer"])require("fs").writeFileSync(`keys/${r}.key`,Wallet.createRandom().privateKey)'
export OWNER_KEY=./keys/owner.key AGENT_KEY=./keys/agent.key RELAYER_KEY=./keys/relayer.key
```

`OWNER_KEY` needs gas to deploy and configure. `RELAYER_KEY` needs gas to submit
payments. `AGENT_KEY` needs nothing, ever — if it ever holds a balance, something
is wrong with how it is being used.

## Deploy

```bash
export NETWORK=mainnet
npm run build
node scripts/probe.mjs                  # every address re-verified before use

node src/cli.mjs deploy --plan          # says what it would do, sends nothing
node src/cli.mjs deploy
export VAULT_ADDRESS=0x…                # printed by deploy
```

Fund it with USDG, the chain's payments unit:

```
0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168   USDG, 6 decimals
```

If you would rather rehearse against a token of your own first, deploy a mock —
and never describe it as USDG:

```bash
node -e '
const {JsonRpcProvider,Wallet,ContractFactory}=require("ethers");
const a=require("./out/MockToken.json");
(async()=>{
  const p=new JsonRpcProvider("https://rpc.testnet.chain.robinhood.com");
  const w=new Wallet(require("fs").readFileSync(process.env.OWNER_KEY,"utf8").trim(),p);
  const c=await new ContractFactory(a.abi,a.bytecode,w).deploy(6);
  await c.waitForDeployment();
  console.log("MOCK TOKEN (not USDG):", await c.getAddress());
})();'
```

Wire it up:

```bash
node src/cli.mjs merchant add --merchant 0xSHOP
node src/cli.mjs grant issue --agent 0xAGENT --token 0xMOCK --cap 50 --days 30
node src/cli.mjs deposit --token 0xMOCK --amount 100
node src/cli.mjs status --agent 0xAGENT
node src/cli.mjs pay --merchant 0xSHOP --amount 1 --plan
node src/cli.mjs pay --merchant 0xSHOP --amount 1
```

The payment is the proof: the agent signed it, the relayer paid the gas, and the
agent's balance never moved.

Run `--plan` on everything first. It prints what would happen and sends nothing.

## Before trusting a deployed vault

```bash
node src/cli.mjs status --agent 0xAGENT
```

Check, in this order:

1. **`owner`** is the address you expect, and `PENDING OWNER` is absent. A
   pending transfer that nobody accepted is a half-finished handover.
2. **`payees`** is the list you approved, and nothing else. An empty list means
   no payment can succeed at all, which is the safe default rather than a fault.
3. **`usable: yes`**. When it says no, it says which of the three reasons —
   revoked, expired, or cap reached — because the fix differs for each.
4. **The agent's balance is zero.** It should never have held anything.

## Stopping an agent

Three scopes, all immediate, none requiring the payee to cooperate:

| Scope | Command | Effect |
| --- | --- | --- |
| One payee | `merchant remove --merchant 0x…` | that payee, and every subscription to them |
| One agent, softly | `grant revise --agent 0x… --cap <spent>` | no headroom left; the grant stays alive |
| One agent, hard | `grant revoke --agent 0x…` | dead, and every intent it already signed dies too |

The soft kill exists because revoke is not always right: revising the cap down to
what has already been spent stops all spending while leaving the grant in place.

## Known limits

**A token that lies about transferring is not detected.** The vault meters what
it authorised, not what the token did. A balance check before and after would
catch it, and would also break fee-on-transfer tokens, which move less on
purpose. The owner chooses the token, so this is stated rather than defended
against — see the test that pins it.

**No native-token payments.** ERC-20 only. USDG is the payments unit, so this has
not been needed.

**Subscriptions have not run on chain.** The logic is tested but the on-chain
period counter has never been exercised against a live network.

**Routes are not built here.** The contract does not encode swap routes — the
caller supplies the router calldata and the contract enforces the outcome. See
the design notes in the README for why.
