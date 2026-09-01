#!/usr/bin/env node
/**
 * CLI for GrantVault.
 *
 * Roles map to three separate key files, and the split is the security model
 * rather than a convenience:
 *
 *   OWNER_KEY    the human. Issues grants, approves payees, withdraws.
 *   AGENT_KEY    the bot. Signs payment intents. Holds nothing, pays no gas.
 *   RELAYER_KEY  submits transactions and pays gas. Cannot authorise anything.
 *
 * Anything that spends supports --plan, which prints what would happen and
 * sends nothing.
 */
import { formatUnits, parseUnits } from "ethers";
import { artifact, connect, erc20At, loadWallet, signPayIntent, status, vaultAt } from "./client.mjs";
import { ContractFactory } from "ethers";

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    flags[k] = v;
  } else positional.push(argv[i]);
}

const NETWORK = flags.network ?? process.env.NETWORK ?? "testnet";
const VAULT = flags.vault ?? process.env.VAULT_ADDRESS;
const PLAN = flags.plan === "true";

const die = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

function needVault() {
  if (!VAULT) die("No vault address. Pass --vault 0x… or set VAULT_ADDRESS.");
  return VAULT;
}

/** Resolve token units from a human amount, refusing to guess decimals. */
async function units(tokenAddr, human, runner) {
  const t = erc20At(tokenAddr, runner);
  let d;
  try {
    d = await t.decimals();
  } catch {
    die(
      `Token ${tokenAddr} did not answer decimals(). Refusing to guess — ` +
        "a wrong decimals value silently changes the amount by orders of magnitude.",
    );
  }
  return { amount: parseUnits(String(human), d), decimals: Number(d) };
}

const HELP = `
  rh-intents — an agent that spends without holding a wallet

  Global:  --network mainnet|testnet   (default testnet)
           --vault 0x…                 (or VAULT_ADDRESS)
           --plan                      print what would happen, send nothing

  Keys are FILE PATHS, never inline:
           OWNER_KEY=./keys/owner.key
           AGENT_KEY=./keys/agent.key
           RELAYER_KEY=./keys/relayer.key

  Commands:
    status [--agent 0x…]                      show owner, payees, grant health
    deploy                                    deploy a vault (owner pays)

    grant issue --agent 0x… --token 0x… --cap 50 --days 30
    grant revise --agent 0x… --cap 50 --days 30
    grant revoke --agent 0x…

    merchant add --merchant 0x…
    merchant remove --merchant 0x…
    merchant list

    deposit --token 0x… --amount 100          owner funds the vault
    withdraw --token 0x… --to 0x… --amount 10

    pay --merchant 0x… --amount 5             agent signs, relayer submits

    tradeable --token 0x… --on|--off        approve an asset for swapping
    swap --in 0x… --out 0x… --amount 100 --min-out 95 --data 0x…

    sub create --agent 0x… --merchant 0x… --amount 15 --days 30
    sub pay --id 1                            charge the current period
    sub show --id 1
    sub cancel --id 1
`;

async function main() {
  const cmd = positional[0];
  if (!cmd || cmd === "help") return console.log(HELP);

  const { provider, cfg } = await connect(NETWORK);

  // ---------------------------------------------------------------- deploy
  if (cmd === "deploy") {
    const owner = loadWallet(process.env.OWNER_KEY, "OWNER").connect(provider);
    const art = artifact("GrantVault");
    if (PLAN) {
      const bal = await provider.getBalance(owner.address);
      console.log(`\n  network      ${NETWORK} (chain ${cfg.chainId})`);
      console.log(`  deployer     ${owner.address}`);
      console.log(`  balance      ${formatUnits(bal, 18)}`);
      console.log(`  vault owner  ${owner.address}`);
      console.log(`  size         ${art.bytecode.length / 2 - 1} bytes\n  (plan only — nothing sent)\n`);
      return;
    }
    const factory = new ContractFactory(art.abi, art.bytecode, owner);
    const c = await factory.deploy(owner.address);
    console.log(`  deploying… ${c.deploymentTransaction().hash}`);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    console.log(`\n  VAULT ${addr}`);
    console.log(`  owner ${owner.address}`);
    console.log(`\n  export VAULT_ADDRESS=${addr}\n`);
    return;
  }

  // ---------------------------------------------------------------- status
  if (cmd === "status") {
    const v = vaultAt(needVault(), provider);
    const s = await status(v, flags.agent);
    console.log(`\n  vault    ${needVault()}  (${NETWORK}, chain ${cfg.chainId})`);
    console.log(`  owner    ${s.owner}`);
    if (s.pendingOwner !== "0x0000000000000000000000000000000000000000") {
      console.log(`  PENDING OWNER ${s.pendingOwner} — transfer started, not accepted`);
    }
    console.log(`  payees   ${s.merchants.length === 0 ? "(none — no payment can succeed)" : ""}`);
    for (const m of s.merchants) console.log(`             ${m}`);
    if (s.agent) {
      console.log(`\n  agent    ${s.agent.address}`);
      if (!s.agent.hasGrant) console.log("           no grant — cannot spend");
      else {
        const a = s.agent;
        console.log(`  token    ${s.token.symbol} ${s.token.address}`);
        console.log(`  cap      ${a.cap}   spent ${a.spent}   remaining ${a.remaining}`);
        console.log(`  expires  ${a.expiresAt}${a.expired ? "  EXPIRED" : ""}`);
        console.log(`  revoked  ${a.revoked}   generation ${a.generation}`);
        console.log(`  vault holds ${s.vaultBalance} ${s.token.symbol}`);
        console.log(`\n  usable:  ${a.usable ? "yes" : "NO"}`);
        if (!a.usable) {
          const why = a.revoked ? "revoked — re-issue" : a.expired ? "expired — revise the expiry" : "cap reached — revise the cap";
          console.log(`           ${why}`);
        }
      }
    }
    console.log();
    return;
  }

  // ----------------------------------------------------------------- grant
  if (cmd === "grant") {
    const owner = loadWallet(process.env.OWNER_KEY, "OWNER").connect(provider);
    const v = vaultAt(needVault(), owner);
    const sub = positional[1];
    const agent = flags.agent ?? die("--agent required");

    if (sub === "revoke") {
      if (PLAN) return console.log(`\n  would revoke the grant for ${agent}\n  every intent already signed by it dies too\n`);
      const tx = await v.revokeGrant(agent);
      console.log(`  revoked  ${(await tx.wait()).hash}`);
      return;
    }

    const days = Number(flags.days ?? die("--days required"));
    const expires = BigInt(Math.floor(Date.now() / 1000) + days * 86400);

    if (sub === "issue") {
      const token = flags.token ?? die("--token required");
      const { amount, decimals } = await units(token, flags.cap ?? die("--cap required"), provider);
      if (PLAN) {
        return console.log(
          `\n  would issue to ${agent}\n  token   ${token} (${decimals} decimals)` +
            `\n  cap     ${flags.cap} (${amount} raw)\n  expires ${new Date(Number(expires) * 1000).toISOString()}\n`,
        );
      }
      const tx = await v.issueGrant(agent, token, amount, expires);
      console.log(`  issued  ${(await tx.wait()).hash}`);
      return;
    }

    if (sub === "revise") {
      const g = await v.grants(agent);
      if (g.expiresAt === 0n) die(`no grant exists for ${agent}`);
      const { amount } = await units(g.token, flags.cap ?? die("--cap required"), provider);
      if (PLAN) {
        return console.log(
          `\n  would revise ${agent}\n  cap ${flags.cap} (spent so far: ${g.spent})` +
            `\n  NOTE: setting cap == spent is the soft kill — the grant stays alive with zero headroom\n`,
        );
      }
      const tx = await v.reviseGrant(agent, amount, expires);
      console.log(`  revised  ${(await tx.wait()).hash}`);
      return;
    }
    die(`unknown: grant ${sub}`);
  }

  // -------------------------------------------------------------- merchant
  if (cmd === "merchant") {
    const sub = positional[1];
    if (sub === "list") {
      const v = vaultAt(needVault(), provider);
      const list = await v.merchants();
      console.log(list.length ? "\n  " + list.join("\n  ") + "\n" : "\n  (empty — every payment is refused)\n");
      return;
    }
    const owner = loadWallet(process.env.OWNER_KEY, "OWNER").connect(provider);
    const v = vaultAt(needVault(), owner);
    const m = flags.merchant ?? die("--merchant required");
    if (sub === "add") {
      if (PLAN) return console.log(`\n  would approve ${m} as a payee\n  check it against the merchant's own published address first\n`);
      console.log(`  added  ${(await (await v.addMerchant(m)).wait()).hash}`);
      return;
    }
    if (sub === "remove") {
      if (PLAN) return console.log(`\n  would remove ${m}\n  the next payment to them fails, and so does every subscription\n`);
      console.log(`  removed  ${(await (await v.removeMerchant(m)).wait()).hash}`);
      return;
    }
    die(`unknown: merchant ${sub}`);
  }

  // ---------------------------------------------------------------- funding
  if (cmd === "deposit" || cmd === "withdraw") {
    const owner = loadWallet(process.env.OWNER_KEY, "OWNER").connect(provider);
    const v = vaultAt(needVault(), owner);
    const token = flags.token ?? die("--token required");
    const { amount } = await units(token, flags.amount ?? die("--amount required"), provider);
    if (cmd === "deposit") {
      if (PLAN) return console.log(`\n  would approve and deposit ${flags.amount} of ${token}\n`);
      const t = erc20At(token, owner);
      console.log(`  approving…`);
      await (await t.approve(needVault(), amount)).wait();
      console.log(`  deposited  ${(await (await v.deposit(token, amount)).wait()).hash}`);
      return;
    }
    const to = flags.to ?? die("--to required");
    if (PLAN) return console.log(`\n  would withdraw ${flags.amount} of ${token} to ${to}\n`);
    console.log(`  withdrawn  ${(await (await v.withdraw(token, to, amount)).wait()).hash}`);
    return;
  }

  // -------------------------------------------------------------------- pay
  if (cmd === "pay") {
    const agentWallet = loadWallet(process.env.AGENT_KEY, "AGENT");
    const relayer = loadWallet(process.env.RELAYER_KEY, "RELAYER").connect(provider);
    if ((await agentWallet.getAddress()) === relayer.address) {
      die("AGENT_KEY and RELAYER_KEY are the same key. The agent must never be the fee payer.");
    }
    const v = vaultAt(needVault(), provider);
    const merchant = flags.merchant ?? die("--merchant required");
    const grant = await v.grants(await agentWallet.getAddress());
    if (grant.expiresAt === 0n) die("this agent has no grant");
    const { amount } = await units(grant.token, flags.amount ?? die("--amount required"), provider);

    if (!(await v.isMerchant(merchant))) {
      die(`${merchant} is not on the allowlist. The chain would refuse this; refusing here first.`);
    }
    const rem = await v.remaining(await agentWallet.getAddress());
    if (amount > rem) die(`amount exceeds remaining headroom (${rem} raw)`);

    const { signature, deadline, agent, generation } = await signPayIntent({
      vault: v, agentWallet, merchant, amount,
    });
    if (PLAN) {
      return console.log(
        `\n  would pay ${flags.amount} to ${merchant}\n  agent      ${agent} (signs, holds nothing)` +
          `\n  relayer    ${relayer.address} (pays gas)\n  generation ${generation}` +
          `\n  deadline   ${new Date(Number(deadline) * 1000).toISOString()}\n  (plan only — nothing sent)\n`,
      );
    }
    const tx = await vaultAt(needVault(), relayer).payWithSig(agent, merchant, amount, deadline, signature);
    const r = await tx.wait();
    console.log(`\n  PAID  ${r.hash}`);
    console.log(`  ${flags.amount} -> ${merchant}`);
    console.log(`  agent ${agent} signed; relayer ${relayer.address} paid the gas\n`);
    return;
  }

  // ------------------------------------------------------------------ swap
  if (cmd === "tradeable") {
    const owner = loadWallet(process.env.OWNER_KEY, "OWNER").connect(provider);
    const v = vaultAt(needVault(), owner);
    const token = flags.token ?? die("--token required");
    const on = flags.off !== "true";
    if (PLAN) {
      const effect = on
        ? "the agent could then hold this asset as swap output"
        : "the next swap into this asset fails immediately";
      console.log("");
      console.log(`  would set ${token} tradeable = ${on}`);
      console.log(`  ${effect}`);
      console.log("");
      return;
    }
    console.log(`  set  ${(await (await v.setTradeable(token, on)).wait()).hash}`);
    return;
  }

  if (cmd === "swap") {
    const agent = loadWallet(process.env.AGENT_KEY, "AGENT").connect(provider);
    const v = vaultAt(needVault(), provider);
    const tokenIn = flags.in ?? die("--in required (token being sold)");
    const tokenOut = flags.out ?? die("--out required (token being bought)");

    // This does not build routes, and says why rather than failing with a bare
    // "missing argument".
    const data =
      flags.data ??
      die(
        [
          "--data required: the router calldata.",
          "",
          "  This does NOT build routes. The chain router is a modified",
          "  UniversalRouter whose v4 swap struct carries an extra",
          "  minHopPriceX36 field, so standard Uniswap SDK calldata reverts.",
          "  Get calldata from a quoter that knows this chain and pass it here.",
          "  The vault bounds the outcome whatever the route does.",
        ].join("\n"),
      );
    if (!data.startsWith("0x") || data.length < 10) {
      die("--data must be 0x-prefixed router calldata");
    }

    const g = await v.grants(await agent.getAddress());
    if (g.expiresAt === 0n) die("this agent has no mandate");

    const { amount: amountIn } = await units(
      tokenIn,
      flags.amount ?? die("--amount required"),
      provider,
    );
    // No default slippage floor. A minOut of zero authorises losing everything,
    // so the caller has to state the number.
    const minHuman =
      flags["min-out"] ?? die("--min-out required — refusing to swap with no slippage floor");
    const { amount: minOut } = await units(tokenOut, minHuman, provider);

    if (tokenOut.toLowerCase() !== g.token.toLowerCase() && !(await v.isTradeable(tokenOut))) {
      die(`${tokenOut} is not approved for trading. Run: tradeable --token ${tokenOut}`);
    }
    const meters = tokenIn.toLowerCase() === g.token.toLowerCase();
    if (meters) {
      const rem = await v.remaining(await agent.getAddress());
      if (amountIn > rem) die(`amount exceeds remaining headroom (${rem} raw)`);
    }

    if (PLAN) {
      const metering = meters
        ? "metered (spending the mandate asset)"
        : "NOT metered (returning to the mandate asset)";
      console.log("");
      console.log(`  would swap ${flags.amount} of ${tokenIn}`);
      console.log(`  for at least ${minHuman} of ${tokenOut}`);
      console.log(`  router    ${await v.ROUTER()}`);
      console.log(`  cap       ${metering}`);
      console.log(`  calldata  ${data.length / 2 - 1} bytes, supplied by you`);
      console.log("");
      console.log(`  the vault bounds it: at most ${flags.amount} leaves, at least`);
      console.log(`  ${minHuman} must arrive, measured from real balances`);
      console.log("");
      console.log("  (plan only — nothing sent)");
      console.log("");
      return;
    }
    const tx = await vaultAt(needVault(), agent).swap(tokenIn, tokenOut, amountIn, minOut, data);
    console.log("");
    console.log(`  SWAPPED  ${(await tx.wait()).hash}`);
    console.log("");
    return;
  }

  // ---------------------------------------------------------- subscriptions
  if (cmd === "sub") {
    const sub = positional[1];
    const v0 = vaultAt(needVault(), provider);

    if (sub === "show") {
      const id = flags.id ?? die("--id required");
      const s = await v0.subscriptions(id);
      if (s.agent === "0x0000000000000000000000000000000000000000") die(`no subscription ${id}`);
      const [due, period] = await v0.isDue(id);
      console.log(`\n  subscription ${id}`);
      console.log(`  agent     ${s.agent}`);
      console.log(`  merchant  ${s.merchant}`);
      console.log(`  amount    ${s.amount} raw   every ${Number(s.periodSeconds) / 86400} days`);
      console.log(`  started   ${new Date(Number(s.startTime) * 1000).toISOString()}`);
      console.log(`  paid      ${s.payments} time(s), last period ${s.lastPaidPeriod}`);
      console.log(`  active    ${s.active}`);
      console.log(`  due now   ${due}${due ? ` (period ${period})` : ""}\n`);
      return;
    }

    if (sub === "pay") {
      const id = flags.id ?? die("--id required");
      const [due, period] = await v0.isDue(id);
      if (!due) die(`subscription ${id} is not due right now — nothing to pay`);
      const relayer = loadWallet(process.env.RELAYER_KEY, "RELAYER").connect(provider);
      if (PLAN) return console.log(`\n  would charge subscription ${id}, period ${period}\n`);
      const tx = await vaultAt(needVault(), relayer).paySubscription(id, period);
      console.log(`  charged period ${period}  ${(await tx.wait()).hash}`);
      return;
    }

    const owner = loadWallet(process.env.OWNER_KEY, "OWNER").connect(provider);
    const v = vaultAt(needVault(), owner);

    if (sub === "cancel") {
      const id = flags.id ?? die("--id required");
      if (PLAN) return console.log(`\n  would cancel subscription ${id}, immediately\n`);
      console.log(`  cancelled  ${(await (await v.cancelSubscription(id)).wait()).hash}`);
      return;
    }

    if (sub === "create") {
      const agent = flags.agent ?? die("--agent required");
      const merchant = flags.merchant ?? die("--merchant required");
      const days = Number(flags.days ?? die("--days required"));
      if (days < 1) die("the minimum period is 1 day — anything faster is a drain vector, and the contract refuses it");
      const g = await v.grants(agent);
      if (g.expiresAt === 0n) die(`no grant exists for ${agent} — issue one first`);
      const { amount } = await units(g.token, flags.amount ?? die("--amount required"), provider);
      if (PLAN) {
        return console.log(
          `\n  would create a subscription\n  agent    ${agent}\n  merchant ${merchant}` +
            `\n  amount   ${flags.amount} every ${days} days\n  the cap still applies; this is not a way around it\n`,
        );
      }
      const tx = await v.createSubscription(agent, merchant, amount, days * 86400, 0);
      const r = await tx.wait();
      const id = await v.nextSubscriptionId();
      console.log(`  created subscription ${id - 1n}  ${r.hash}`);
      return;
    }
    die(`unknown: sub ${sub}`);
  }

  die(`unknown command "${cmd}" — run with no arguments for help`);
}

main().catch((e) => die(e.shortMessage ?? e.message));
