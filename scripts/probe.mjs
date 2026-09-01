#!/usr/bin/env node
/**
 * Re-verify every claim in chain.json against the live chain.
 *
 * This exists because the alternative is a README full of addresses nobody has
 * checked since the day they were pasted. Run it before trusting the file, and
 * again before anything is deployed. It exits non-zero when reality disagrees.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "..", "chain.json"), "utf8"));
const net = process.argv[2] === "testnet" ? "testnet" : "mainnet";
const { rpc, chainId } = cfg.networks[net];

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${label.padEnd(26)} ${detail}`);
  if (!pass) failures++;
};

async function rpcCall(method, params) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const hasCode = async (addr) => {
  const code = await rpcCall("eth_getCode", [addr, "latest"]);
  return code && code !== "0x";
};

/** Decode an ABI-encoded string return. */
function decodeString(hex) {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) return null;
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}

console.log(`\nProbing ${net} — ${rpc}\n`);

// --- chain identity -------------------------------------------------------
const liveChainId = parseInt(await rpcCall("eth_chainId", []), 16);
ok("chainId", liveChainId === chainId, `${liveChainId}${liveChainId === chainId ? "" : ` (expected ${chainId})`}`);

const client = await rpcCall("web3_clientVersion", []);
ok("nitro stack", /nitro/i.test(client), client);

const block = parseInt(await rpcCall("eth_blockNumber", []), 16);
ok("chain is producing", block > 0, `block ${block.toLocaleString()}`);

// --- account abstraction --------------------------------------------------
// Without an EntryPoint there is no agent-without-a-wallet story on this chain,
// so this is the load-bearing check, not a nice-to-have.
console.log("\n  ERC-4337");
for (const [name, addr] of Object.entries(cfg.erc4337)) {
  if (name.startsWith("_")) continue;
  ok(name, await hasCode(addr), addr);
}

console.log("\n  infrastructure");
for (const [name, addr] of Object.entries(cfg.infrastructure)) {
  ok(name, await hasCode(addr), addr);
}

// --- tokens ---------------------------------------------------------------
// A wrong decimals value silently changes what a spending cap means, so check
// the number rather than trusting the doc page.
console.log("\n  tokens");
const tokens = cfg.networks[net].tokens ?? {};
if (Object.keys(tokens).length === 0) console.log("    (none configured for this network)");
for (const [name, t] of Object.entries(tokens)) {
  const [symHex, decHex] = await Promise.all([
    rpcCall("eth_call", [{ to: t.address, data: "0x95d89b41" }, "latest"]), // symbol()
    rpcCall("eth_call", [{ to: t.address, data: "0x313ce567" }, "latest"]), // decimals()
  ]);
  const sym = decodeString(symHex);
  const dec = parseInt(decHex, 16);
  ok(`${name} symbol`, sym === t.symbol, `${sym}`);
  ok(`${name} decimals`, dec === t.decimals, `${dec}`);
}

// --- gas ------------------------------------------------------------------
const gasPrice = parseInt(await rpcCall("eth_gasPrice", []), 16);
console.log(`\n  gas price: ${gasPrice} wei (${(gasPrice / 1e9).toFixed(4)} gwei)`);

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} check(s) FAILED — chain.json is out of date.\n`,
);
process.exit(failures === 0 ? 0 : 1);
