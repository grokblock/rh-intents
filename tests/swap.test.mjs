import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { Chain, KEYS } from "./helpers.mjs";

const YEAR = 365 * 24 * 3600;
const U = (n) => BigInt(Math.round(n * 1e6)); // 6-decimal units, like USDG
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";

const routerIface = new Interface([
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
  "function steal(address tokenIn, uint256 amountIn)",
  "function overdraw(address tokenIn, uint256 amountIn)",
  "function noop()",
  "function boom()",
]);
const call = (fn, args = []) => routerIface.encodeFunctionData(fn, args);

/** Vault holding USDG-alike, a mandate, and a tradeable second asset. */
async function fixture({ cap = U(1000) } = {}) {
  const chain = await Chain.create();
  const owner = await chain.account(KEYS.owner);
  const agent = await chain.account(KEYS.agent);
  const relayer = await chain.account(KEYS.relayer);
  const outsider = await chain.account(KEYS.outsider);

  // The mock lives at the real router address, because the vault pins it.
  const router = await chain.etch(ROUTER, "MockRouter");

  const usdg = await chain.deploy(owner, "MockToken", [6]);
  const stock = await chain.deploy(owner, "MockToken", [6]);
  const junk = await chain.deploy(owner, "MockToken", [6]);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);

  await usdg.send(owner, "mint", [vault.address, U(10000)]);
  await vault.send(owner, "issueGrant", [agent.hex, usdg.address, cap, chain.time + BigInt(YEAR)]);
  await vault.send(owner, "setTradeable", [stock.address, true]);

  return { chain, owner, agent, relayer, outsider, router, usdg, stock, junk, vault };
}

test("the happy path: mandate asset in, approved asset out", async () => {
  const { agent, usdg, stock, vault } = await fixture();

  const r = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), U(90),
    call("swap", [usdg.address, stock.address, U(100), U(95)]),
  ]);
  assert.equal(r.ok, true, vault.errorName(r) ?? r.error ?? "");

  assert.equal(await stock.call("balanceOf", [vault.address]), U(95));
  assert.equal(await usdg.call("balanceOf", [vault.address]), U(10000) - U(100));
  // Spending the mandate asset meters the cap.
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], U(100), "spent");
});

test("minOut is enforced from real balances, not the router's word", async () => {
  // The router reports nothing; the vault measures. A route that returns less
  // than promised reverts even though the call itself succeeded.
  const { agent, usdg, stock, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), U(90),
    call("swap", [usdg.address, stock.address, U(100), U(50)]), // delivers 50, promised 90
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "MinOutNotMet");
  assert.equal(await stock.call("balanceOf", [vault.address]), 0n, "nothing kept");
  assert.equal(await usdg.call("balanceOf", [vault.address]), U(10000), "nothing lost");
});

test("a router that takes the input and returns nothing is caught", async () => {
  const { agent, usdg, stock, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), 1n,
    call("steal", [usdg.address, U(100)]),
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "MinOutNotMet");
  assert.equal(await usdg.call("balanceOf", [vault.address]), U(10000), "the whole tx reverted");
});

test("the allowance does not outlive the call", async () => {
  // The one place this contract calls approve. If an allowance survived, a
  // revoked mandate would leave a live capability behind — exactly what the
  // no-approve rule exists to prevent.
  const { agent, usdg, stock, vault } = await fixture();
  await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), U(90),
    call("swap", [usdg.address, stock.address, U(100), U(95)]),
  ]);
  assert.equal(await usdg.call("allowance", [vault.address, ROUTER]), 0n);
});

test("a router cannot pull more than the authorised amount", async () => {
  // The allowance is exactly amountIn, so an overdraw fails inside the token
  // rather than reaching the vault's own accounting.
  const { agent, usdg, stock, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), 1n,
    call("overdraw", [usdg.address, U(500)]),
  ]);
  assert.equal(r.ok, false);
  assert.equal(await usdg.call("balanceOf", [vault.address]), U(10000));
});

test("swapping into a token the owner never approved is refused", async () => {
  // Sell the mandate asset for one wei of something worthless and the value is
  // gone while the cap looks respected. The output allowlist is what stops it.
  const { agent, usdg, junk, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, junk.address, U(100), 1n,
    call("swap", [usdg.address, junk.address, U(100), 1n]),
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "TokenNotTradeable");
});

test("selling back into the mandate asset costs no cap", async () => {
  // The asymmetry that makes revise-to-spent a usable soft kill: an agent with
  // zero headroom can still unwind, where a revoke would strand it.
  const { owner, agent, chain, usdg, stock, vault } = await fixture();
  await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), U(90),
    call("swap", [usdg.address, stock.address, U(100), U(95)]),
  ]);
  // Soft kill: no headroom left at all.
  await vault.send(owner, "reviseGrant", [agent.hex, U(100), chain.time + BigInt(YEAR)]);
  assert.equal(await vault.call("remaining", [agent.hex]), 0n);

  const back = await vault.send(agent, "swap", [
    stock.address, usdg.address, U(95), U(90),
    call("swap", [stock.address, usdg.address, U(95), U(96)]),
  ]);
  assert.equal(back.ok, true, "must still be able to unwind: " + (vault.errorName(back) ?? ""));
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], U(100), "selling added nothing to spent");
});

test("the cap is a ceiling on buying, same as on paying", async () => {
  const { agent, usdg, stock, vault } = await fixture({ cap: U(150) });
  await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), U(90),
    call("swap", [usdg.address, stock.address, U(100), U(95)]),
  ]);
  const over = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), U(90),
    call("swap", [usdg.address, stock.address, U(100), U(95)]),
  ]);
  assert.equal(over.ok, false);
  assert.equal(vault.errorName(over), "CapExceeded");
});

test("a revoked or expired mandate cannot trade", async () => {
  const { chain, owner, agent, usdg, stock, vault } = await fixture();
  const data = call("swap", [usdg.address, stock.address, U(10), U(10)]);

  await vault.send(owner, "revokeGrant", [agent.hex]);
  let r = await vault.send(agent, "swap", [usdg.address, stock.address, U(10), 1n, data]);
  assert.equal(vault.errorName(r), "GrantRevoked");

  await vault.send(owner, "issueGrant", [agent.hex, usdg.address, U(1000), chain.time + 100n]);
  chain.warp(200);
  r = await vault.send(agent, "swap", [usdg.address, stock.address, U(10), 1n, data]);
  assert.equal(vault.errorName(r), "GrantExpired");
});

test("an agent with no mandate cannot trade", async () => {
  const { outsider, usdg, stock, vault } = await fixture();
  const r = await vault.send(outsider, "swap", [
    usdg.address, stock.address, U(10), 1n,
    call("swap", [usdg.address, stock.address, U(10), U(10)]),
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "GrantMissing");
});

test("a reverting route changes nothing", async () => {
  const { agent, usdg, stock, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), 1n, call("boom"),
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "RouterCallFailed");
  assert.equal(await usdg.call("balanceOf", [vault.address]), U(10000));
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], 0n, "a failed route must not consume cap");
});

test("a route that does nothing at all is caught by minOut", async () => {
  const { agent, usdg, stock, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, stock.address, U(100), 1n, call("noop"),
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "MinOutNotMet");
});

test("empty router calldata is refused rather than sent", async () => {
  const { agent, usdg, stock, vault } = await fixture();
  const r = await vault.send(agent, "swap", [usdg.address, stock.address, U(100), 1n, "0x"]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "EmptyRouterData");
});

test("swapping a token for itself is refused", async () => {
  const { agent, usdg, vault } = await fixture();
  const r = await vault.send(agent, "swap", [
    usdg.address, usdg.address, U(100), 1n,
    call("swap", [usdg.address, usdg.address, U(100), U(100)]),
  ]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "SwapSameToken");
});

test("only the owner decides what is tradeable", async () => {
  const { outsider, junk, vault } = await fixture();
  const r = await vault.send(outsider, "setTradeable", [junk.address, true]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "NotOwner");
});

test("un-approving a token stops the next trade into it", async () => {
  const { owner, agent, usdg, stock, vault } = await fixture();
  const data = call("swap", [usdg.address, stock.address, U(10), U(10)]);
  assert.equal((await vault.send(agent, "swap", [usdg.address, stock.address, U(10), 1n, data])).ok, true);

  await vault.send(owner, "setTradeable", [stock.address, false]);
  const after = await vault.send(agent, "swap", [usdg.address, stock.address, U(10), 1n, data]);
  assert.equal(after.ok, false);
  assert.equal(vault.errorName(after), "TokenNotTradeable");
});

test("the router address is the real one, hardcoded", async () => {
  // The swap forwards caller-supplied calldata. That is only safe because the
  // destination is a constant — if this ever became configurable, the whole
  // shape would need rethinking.
  const { vault } = await fixture();
  const onChain = await vault.call("ROUTER", []);
  assert.equal(onChain.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(
    onChain.toLowerCase(),
    "0x8876789976decbfcbbbe364623c63652db8c0904",
    "must equal the address verified deployed on Robinhood Chain",
  );
});
