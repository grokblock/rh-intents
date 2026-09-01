#!/usr/bin/env node
/**
 * Execute one real swap through the vault, on mainnet.
 *
 * NOTE ON GAS: swap() is called by the agent, and GrantVault has no gasless
 * swapWithSig yet — so the agent needs a little native token to send this. That
 * is a gap in the contract, not the intended design: the payment path has
 * payWithSig precisely so the agent never needs gas, and the swap path should
 * have the same. Until it does, this script needs the agent funded, which is
 * exactly the property the project exists to avoid.
 */
import { readFileSync } from "node:fs";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const VAULT = "0x7a7358B901eED1D8012088734ED03aD605F7b50B";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";

const abi = AbiCoder.defaultAbiCoder();
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const agent = new Wallet(readFileSync("./keys/agent.key", "utf8").trim(), provider);
const abiJson = JSON.parse(readFileSync("./out/GrantVault.json", "utf8")).abi;
const vault = new Contract(VAULT, abiJson, agent);

const erc20 = ["function balanceOf(address) view returns (uint256)"];
const usdg = new Contract(USDG, erc20, provider);
const weth = new Contract(WETH, erc20, provider);

const path = "0x" + USDG.slice(2).toLowerCase() + (100).toString(16).padStart(6, "0") + WETH.slice(2).toLowerCase();
const amountIn = parseUnits("1", 6);

function routerData(minOut) {
  const inputs = [
    abi.encode(
      // Six fields: this chain's fork adds a trailing dynamic one.
      ["address", "uint256", "uint256", "bytes", "bool", "bytes"],
      [MSG_SENDER, amountIn, minOut, path, false, "0x"],
    ),
  ];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  return "0x3593564c" + abi.encode(["bytes", "bytes[]", "uint256"], ["0x00", inputs, deadline]).slice(2);
}

// Quote by simulation, then set the floor 1% under it. Never send with minOut 0.
const quoted = await vault.swap.staticCall(USDG, WETH, amountIn, 0n, routerData(0n), { from: agent.address });
const minOut = (quoted * 99n) / 100n;
console.log(`\n  quote    1 USDG -> ${formatUnits(quoted, 18)} WETH`);
console.log(`  floor    ${formatUnits(minOut, 18)} WETH  (1% under)\n`);

const before = { usdg: await usdg.balanceOf(VAULT), weth: await weth.balanceOf(VAULT) };
const g0 = await vault.grants(agent.address);

const tx = await vault.swap(USDG, WETH, amountIn, minOut, routerData(minOut));
console.log(`  sent     ${tx.hash}`);
const rcpt = await tx.wait();
console.log(`  block    ${rcpt.blockNumber}   gas ${rcpt.gasUsed}`);

const after = { usdg: await usdg.balanceOf(VAULT), weth: await weth.balanceOf(VAULT) };
const g1 = await vault.grants(agent.address);

console.log(`\n  vault USDG  ${formatUnits(before.usdg, 6)} -> ${formatUnits(after.usdg, 6)}`);
console.log(`  vault WETH  ${formatUnits(before.weth, 18)} -> ${formatUnits(after.weth, 18)}`);
console.log(`  cap spent   ${formatUnits(g0.spent, 6)} -> ${formatUnits(g1.spent, 6)}  (buying meters)`);
console.log(`\n  agent USDG  ${formatUnits(await usdg.balanceOf(agent.address), 6)}  <- must be 0`);
console.log(`  agent WETH  ${formatUnits(await weth.balanceOf(agent.address), 18)}  <- must be 0\n`);
