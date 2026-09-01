#!/usr/bin/env node
/**
 * Find a working native -> USDG route by simulation, and report WHY each
 * candidate fails rather than just that it did.
 *
 * The calldata shape is copied from a real native-in swap on this chain
 * (WRAP_ETH to the router, then V3_SWAP_EXACT_IN paying from the router's own
 * balance), so anything that fails here is a routing or liquidity problem, not
 * an encoding one.
 */
import { readFileSync } from "node:fs";
import { AbiCoder, JsonRpcProvider, Wallet, formatUnits, parseEther } from "ethers";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

const abi = AbiCoder.defaultAbiCoder();
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const wallet = new Wallet(readFileSync(process.env.OWNER_KEY, "utf8").trim(), provider);

const packPath = (hops) =>
  "0x" +
  hops
    .map((h) => (typeof h === "number" ? h.toString(16).padStart(6, "0") : h.slice(2).toLowerCase()))
    .join("");

function calldata(amountIn, minOut, hops) {
  const commands = "0x0b00";
  const inputs = [
    abi.encode(["address", "uint256"], [ADDRESS_THIS, amountIn]),
    abi.encode(
      // SIX parameters, not the standard five. This chain runs a modified
      // UniversalRouter whose V3_SWAP_EXACT_IN carries a trailing dynamic field
      // (the minHopPriceX36 hook the docs mention for v4 — it is on the v3 path
      // too). Omitting it makes the router read past the end of the calldata and
      // revert with SliceOutOfBounds(). Empty means "no per-hop price limit".
      ["address", "uint256", "uint256", "bytes", "bool", "bytes"],
      [MSG_SENDER, amountIn, minOut, packPath(hops), false, "0x"],
    ),
  ];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  return "0x3593564c" + abi.encode(["bytes", "bytes[]", "uint256"], [commands, inputs, deadline]).slice(2);
}

async function tryRoute(label, amountIn, hops) {
  const data = calldata(amountIn, 0n, hops);
  try {
    await provider.call({ from: wallet.address, to: ROUTER, data, value: amountIn });
    const gas = await provider.estimateGas({ from: wallet.address, to: ROUTER, data, value: amountIn });
    console.log(`  OK    ${label.padEnd(34)} ~${gas} gas`);
    return { hops, amountIn };
  } catch (e) {
    // The raw revert payload names the error where the message does not.
    const raw = e.data ?? e.info?.error?.data ?? e.error?.data ?? "";
    let why = e.shortMessage ?? e.message ?? "";
    if (typeof raw === "string" && raw.length >= 10) why += `  [${raw.slice(0, 10)}]`;
    console.log(`  fail  ${label.padEnd(34)} ${why.slice(0, 74)}`);
    return null;
  }
}

const amounts = ["0.0005", "0.002", "0.004"];
console.log(`\n  from ${wallet.address}\n`);

let winner = null;
for (const a of amounts) {
  const amt = parseEther(a);
  for (const fee of [100, 500, 3000, 10000]) {
    const r = await tryRoute(`${a} native  WETH -[${fee}]-> USDG`, amt, [WETH, fee, USDG]);
    if (r && !winner) winner = r;
  }
}

console.log(
  winner
    ? `\n  WORKS: ${formatUnits(winner.amountIn, 18)} native via fee ${winner.hops[1]}\n`
    : "\n  No direct route works. The pool exists but will not take this trade.\n",
);
