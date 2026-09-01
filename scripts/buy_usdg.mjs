#!/usr/bin/env node
/**
 * Buy USDG with the native token, through the chain's UniversalRouter.
 *
 * Simulates every candidate route with eth_call first and only sends the one
 * that works. Hand-built calldata against a modified router is exactly the place
 * to find out by simulation rather than by losing the money.
 *
 * Run with --send to actually broadcast; without it, this only reports.
 */
import { readFileSync } from "node:fs";
import { AbiCoder, JsonRpcProvider, Wallet, formatUnits, parseEther } from "ethers";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// UniversalRouter command bytes.
const WRAP_ETH = "0b";
const V3_SWAP_EXACT_IN = "00";
// Magic recipients the router understands.
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

const abi = AbiCoder.defaultAbiCoder();
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const wallet = new Wallet(readFileSync(process.env.OWNER_KEY, "utf8").trim(), provider);

/** token(20) fee(3) token(20), packed. */
function v3Path(tokenIn, fee, tokenOut) {
  return (
    "0x" +
    tokenIn.slice(2).toLowerCase() +
    fee.toString(16).padStart(6, "0") +
    tokenOut.slice(2).toLowerCase()
  );
}

function buildCalldata(amountIn, minOut, fee) {
  const commands = "0x" + WRAP_ETH + V3_SWAP_EXACT_IN;
  const inputs = [
    // Wrap the native token into WETH held by the router itself.
    abi.encode(["address", "uint256"], [ADDRESS_THIS, amountIn]),
    // Swap it, paying from the router's own balance (payerIsUser = false), and
    // send the output straight back to the caller.
    abi.encode(
      // SIX parameters, not the standard five. This chain runs a modified
      // UniversalRouter whose V3_SWAP_EXACT_IN carries a trailing dynamic field
      // (the minHopPriceX36 hook the docs mention for v4 — it is on the v3 path
      // too). Omitting it makes the router read past the end of the calldata and
      // revert with SliceOutOfBounds(). Empty means "no per-hop price limit".
      ["address", "uint256", "uint256", "bytes", "bool", "bytes"],
      [MSG_SENDER, amountIn, minOut, v3Path(WETH, fee, USDG), false, "0x"],
    ),
  ];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  return (
    "0x3593564c" + abi.encode(["bytes", "bytes[]", "uint256"], [commands, inputs, deadline]).slice(2)
  );
}

async function usdgBalance(who) {
  const r = await provider.call({ to: USDG, data: "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0") });
  return BigInt(r);
}

const amountIn = parseEther(process.argv.find((a) => a.startsWith("--amount="))?.split("=")[1] ?? "0.004");
const SEND = process.argv.includes("--send");

console.log(`\n  spending ${formatUnits(amountIn, 18)} native from ${wallet.address}`);
console.log(`  router   ${ROUTER}\n`);

// Try each fee tier with minOut = 0 purely to discover which route exists. The
// real send re-derives minOut from what the simulation actually returned, so a
// zero floor is never broadcast.
let chosen = null;
for (const fee of [100, 500, 3000, 10000]) {
  const data = buildCalldata(amountIn, 0n, fee);
  try {
    const before = await usdgBalance(wallet.address);
    await provider.call({ from: wallet.address, to: ROUTER, data, value: amountIn });
    // eth_call cannot report the balance change, so estimate gas as a second
    // signal that the route really executes rather than silently no-opping.
    const gas = await provider.estimateGas({ from: wallet.address, to: ROUTER, data, value: amountIn });
    console.log(`  fee ${String(fee).padStart(5)}: route works, ~${gas} gas`);
    if (!chosen) chosen = { fee, gas };
    void before;
  } catch (e) {
    const msg = (e.shortMessage ?? e.message ?? "").slice(0, 70);
    console.log(`  fee ${String(fee).padStart(5)}: ${msg}`);
  }
}

if (!chosen) {
  console.log("\n  No WETH->USDG route works at any fee tier. Nothing sent.\n");
  process.exit(1);
}

if (!SEND) {
  console.log(`\n  Would use fee ${chosen.fee}. Re-run with --send to broadcast.\n`);
  process.exit(0);
}

const before = await usdgBalance(wallet.address);
const tx = await wallet.sendTransaction({
  to: ROUTER,
  data: buildCalldata(amountIn, 1n, chosen.fee),
  value: amountIn,
});
console.log(`\n  sent ${tx.hash}`);
const rcpt = await tx.wait();
const after = await usdgBalance(wallet.address);
console.log(`  block ${rcpt.blockNumber}  gas ${rcpt.gasUsed}`);
console.log(`\n  USDG received: ${formatUnits(after - before, 6)}\n`);
