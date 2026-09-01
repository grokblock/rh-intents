/**
 * Client for GrantVault.
 *
 * Shaped after grokchain-mcp deliberately, because those choices were the ones
 * that survived contact with a live chain:
 *
 *   - Keys are PATHS, never inline secret material. A key pasted into an
 *     argument is in a shell history, a log, and a transcript before anyone
 *     notices.
 *   - Refuse rather than guess. Every function that cannot determine a value
 *     throws instead of substituting a plausible one — a wrong number here
 *     spends real money.
 *   - Say what will happen before it happens. Anything that moves funds can be
 *     planned first.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, formatUnits, keccak256, parseUnits } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export const CHAINS = JSON.parse(readFileSync(join(root, "chain.json"), "utf8"));

export function artifact(name) {
  return JSON.parse(readFileSync(join(root, "out", `${name}.json`), "utf8"));
}

/**
 * Load a keypair from a FILE PATH. Accepts a 0x-prefixed private key or a JSON
 * object with a `privateKey` field.
 *
 * Deliberately never accepts a key as a string argument: the whole point of the
 * grant model is that keys stay where the human put them.
 */
export function loadWallet(path, label) {
  if (!path) {
    throw new Error(
      `${label} key path is not set. Point it at a file (e.g. AGENT_KEY=./keys/agent.key) — ` +
        "this tool never takes a private key as an argument.",
    );
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (e) {
    throw new Error(`${label} key file could not be read at ${path}: ${e.code ?? e.message}`);
  }
  let key = raw;
  if (raw.startsWith("{")) {
    const j = JSON.parse(raw);
    key = j.privateKey ?? j.key;
    if (!key) throw new Error(`${label} key file has no "privateKey" field`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${label} key file does not contain a 32-byte hex private key`);
  }
  return new Wallet(key);
}

/** Refuse to act against a chain that is not one of ours. */
export async function connect(network = "mainnet") {
  const cfg = CHAINS.networks[network];
  if (!cfg) throw new Error(`unknown network "${network}" — expected mainnet or testnet`);
  const provider = new JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: true });
  const live = Number((await provider.getNetwork()).chainId);
  if (live !== cfg.chainId) {
    throw new Error(
      `RPC ${cfg.rpc} reports chain id ${live}, expected ${cfg.chainId}. ` +
        "Refusing to continue: signing for the wrong chain is how funds go somewhere unrecoverable.",
    );
  }
  return { provider, cfg, network };
}

export function vaultAt(address, runner) {
  return new Contract(address, artifact("GrantVault").abi, runner);
}

export function erc20At(address, runner) {
  const abi = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
  ];
  return new Contract(address, abi, runner);
}

/**
 * Sign a Pay intent.
 *
 * The generation is read from chain rather than passed in: a caller who
 * remembered a stale generation would produce a signature that fails at the
 * contract with an opaque error, and the whole point of embedding it is that a
 * revoked grant kills intents already in flight.
 */
export async function signPayIntent({ vault, agentWallet, merchant, amount, deadlineSeconds = 900 }) {
  const agent = await agentWallet.getAddress();
  const [grant, nonce, net] = await Promise.all([
    vault.grants(agent),
    vault.nonces(agent),
    vault.runner.provider.getNetwork(),
  ]);
  if (grant.expiresAt === 0n) {
    throw new Error(`no grant exists for agent ${agent} — the owner must issue one first`);
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const domain = {
    name: "GrantVault",
    version: "1",
    chainId: Number(net.chainId),
    verifyingContract: await vault.getAddress(),
  };
  const types = {
    Pay: [
      { name: "agent", type: "address" },
      { name: "merchant", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "generation", type: "uint32" },
    ],
  };
  const value = {
    agent,
    merchant,
    amount,
    nonce,
    deadline,
    generation: Number(grant.generation),
  };
  const signature = await agentWallet.signTypedData(domain, types, value);
  return { signature, deadline, agent, nonce, generation: Number(grant.generation) };
}

/**
 * Sign a Swap intent, so a relayer can submit the trade and the agent never
 * needs gas.
 *
 * The router calldata is signed as a HASH. Without that, a relayer could keep
 * the agent's amounts and swap the route — pushing the trade through a pool it
 * controls. minOut bounds the damage; it does not make the substitution
 * acceptable.
 */
export async function signSwapIntent({ vault, agentWallet, tokenIn, tokenOut, amountIn, minOut, routerData, deadlineSeconds = 900 }) {
  const agent = await agentWallet.getAddress();
  const [grant, nonce, net] = await Promise.all([
    vault.grants(agent),
    vault.nonces(agent),
    vault.runner.provider.getNetwork(),
  ]);
  if (grant.expiresAt === 0n) {
    throw new Error(`no mandate exists for agent ${agent} — the owner must issue one first`);
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const domain = {
    name: "GrantVault",
    version: "1",
    chainId: Number(net.chainId),
    verifyingContract: await vault.getAddress(),
  };
  const types = {
    Swap: [
      { name: "agent", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "routerDataHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "generation", type: "uint32" },
    ],
  };
  const value = {
    agent,
    tokenIn,
    tokenOut,
    amountIn,
    minOut,
    routerDataHash: keccak256(routerData),
    nonce,
    deadline,
    generation: Number(grant.generation),
  };
  const signature = await agentWallet.signTypedData(domain, types, value);
  return { signature, deadline, agent, nonce, generation: Number(grant.generation) };
}

/** Everything an operator needs to see before trusting a vault. */
export async function status(vault, agentAddress) {
  const [owner, pendingOwner, merchants] = await Promise.all([
    vault.owner(),
    vault.pendingOwner(),
    vault.merchants(),
  ]);
  const out = { owner, pendingOwner, merchants, agent: null, token: null };

  if (agentAddress) {
    const grant = await vault.grants(agentAddress);
    if (grant.expiresAt === 0n) {
      out.agent = { address: agentAddress, hasGrant: false };
    } else {
      const token = erc20At(grant.token, vault.runner);
      let decimals = 18;
      let symbol = "?";
      try {
        [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
      } catch {
        // A token that does not answer is worth surfacing, not papering over.
        symbol = "(token did not answer decimals/symbol)";
      }
      const now = Math.floor(Date.now() / 1000);
      const expired = Number(grant.expiresAt) <= now;
      out.token = { address: grant.token, symbol, decimals: Number(decimals) };
      out.agent = {
        address: agentAddress,
        hasGrant: true,
        cap: formatUnits(grant.cap, decimals),
        spent: formatUnits(grant.spent, decimals),
        remaining: formatUnits(await vault.remaining(agentAddress), decimals),
        expiresAt: new Date(Number(grant.expiresAt) * 1000).toISOString(),
        expired,
        revoked: grant.revoked,
        generation: Number(grant.generation),
        // A grant can be dead three different ways and an operator needs to know
        // which, because the fix differs: top up, extend, or re-issue.
        usable: !grant.revoked && !expired && grant.cap > grant.spent,
      };
      out.vaultBalance = formatUnits(await token.balanceOf(await vault.getAddress()), decimals);
    }
  }
  return out;
}

export { formatUnits, parseUnits };
