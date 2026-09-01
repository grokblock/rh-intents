import assert from "node:assert/strict";
import { test } from "node:test";
import { Chain, Contract, KEYS, signPay } from "./helpers.mjs";

const YEAR = 365 * 24 * 3600;
const future = () => BigInt(Math.floor(Date.now() / 1000) + YEAR);
const USDG6 = (n) => BigInt(Math.round(n * 1e6)); // USDG has 6 decimals

/** A vault with a funded token, one grant, and one approved payee. */
async function fixture({ cap = USDG6(50), tokenName = "MockToken", tokenArgs = [6] } = {}) {
  const chain = await Chain.create();
  const owner = await chain.account(KEYS.owner);
  const agent = await chain.account(KEYS.agent);
  const relayer = await chain.account(KEYS.relayer);
  const merchant = await chain.account(KEYS.merchant);
  const outsider = await chain.account(KEYS.outsider);

  const token = await chain.deploy(owner, tokenName, tokenArgs);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);

  await token.send(owner, "mint", [vault.address, USDG6(1000)]);
  await vault.send(owner, "issueGrant", [agent.hex, token.address, cap, future()]);
  await vault.send(owner, "addMerchant", [merchant.hex]);

  return { chain, owner, agent, relayer, merchant, outsider, token, vault };
}

test("the happy path: agent spends, merchant is paid, cap is metered", async () => {
  const { agent, merchant, token, vault } = await fixture();

  const r = await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(10));
  assert.equal(await vault.call("remaining", [agent.hex]), USDG6(40));

  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], USDG6(10), "spent");
});

test("the agent never holds the money, before or after", async () => {
  const { agent, merchant, token, vault } = await fixture();
  assert.equal(await token.call("balanceOf", [agent.hex]), 0n);
  await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  // The whole thesis: funds go vault -> merchant. The agent is never a stop
  // on that route, not even for one instruction.
  assert.equal(await token.call("balanceOf", [agent.hex]), 0n);
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(10));
});

test("the cap is a ceiling, not a suggestion", async () => {
  const { agent, merchant, vault, token } = await fixture({ cap: USDG6(50) });
  await vault.send(agent, "pay", [merchant.hex, USDG6(45)]);

  const over = await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  assert.equal(over.ok, false);
  assert.equal(vault.errorName(over), "CapExceeded");
  // The failed attempt must not have moved anything or consumed headroom.
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(45));
  assert.equal(await vault.call("remaining", [agent.hex]), USDG6(5));

  const exact = await vault.send(agent, "pay", [merchant.hex, USDG6(5)]);
  assert.equal(exact.ok, true, "spending the last unit is allowed");
  assert.equal(await vault.call("remaining", [agent.hex]), 0n);
});

test("paying anyone not on the allowlist is refused", async () => {
  const { agent, outsider, vault, token } = await fixture();
  const r = await vault.send(agent, "pay", [outsider.hex, USDG6(1)]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "PayeeNotAllowed");
  assert.equal(await token.call("balanceOf", [outsider.hex]), 0n);
});

test("removing a merchant stops the next payment immediately", async () => {
  const { owner, agent, merchant, vault } = await fixture();
  assert.equal((await vault.send(agent, "pay", [merchant.hex, USDG6(1)])).ok, true);
  await vault.send(owner, "removeMerchant", [merchant.hex]);
  const after = await vault.send(agent, "pay", [merchant.hex, USDG6(1)]);
  assert.equal(after.ok, false);
  assert.equal(vault.errorName(after), "PayeeNotAllowed");
  assert.equal(await vault.call("merchantCount", []), 0n);
});

test("only the owner can issue, revise, revoke, or change the allowlist", async () => {
  const { agent, outsider, token, vault, merchant } = await fixture();
  const calls = [
    ["issueGrant", [outsider.hex, token.address, USDG6(1), future()]],
    ["reviseGrant", [agent.hex, USDG6(1), future()]],
    ["revokeGrant", [agent.hex]],
    ["addMerchant", [outsider.hex]],
    ["removeMerchant", [merchant.hex]],
    ["withdraw", [token.address, outsider.hex, USDG6(1)]],
  ];
  for (const [fn, args] of calls) {
    const r = await vault.send(outsider, fn, args);
    assert.equal(r.ok, false, `${fn} must reject a non-owner`);
    assert.equal(vault.errorName(r), "NotOwner", fn);
  }
});

test("revoke stops payment; revise-to-spent is the soft kill", async () => {
  // Both stop spending. The difference is that revoke marks the grant dead,
  // while a revised cap leaves it alive with zero headroom — which is what you
  // want when an agent must still be able to act, just not to spend.
  const { owner, agent, merchant, vault } = await fixture();
  await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);

  await vault.send(owner, "reviseGrant", [agent.hex, USDG6(10), future()]);
  const softKilled = await vault.send(agent, "pay", [merchant.hex, 1n]);
  assert.equal(softKilled.ok, false);
  assert.equal(vault.errorName(softKilled), "CapExceeded");
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[4], false, "revise must not mark the grant revoked");

  await vault.send(owner, "revokeGrant", [agent.hex]);
  const revoked = await vault.send(agent, "pay", [merchant.hex, 1n]);
  assert.equal(revoked.ok, false);
  assert.equal(vault.errorName(revoked), "GrantRevoked");
});

test("a cap below what is already spent is refused", async () => {
  // Otherwise `spent > cap` and the headroom subtraction underflows.
  const { owner, agent, merchant, vault } = await fixture();
  await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  const r = await vault.send(owner, "reviseGrant", [agent.hex, USDG6(9), future()]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "CapBelowSpent");
});

test("an agent with no grant cannot spend", async () => {
  const { outsider, merchant, vault } = await fixture();
  const r = await vault.send(outsider, "pay", [merchant.hex, USDG6(1)]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "GrantMissing");
});

test("an expiry in the past is refused at issue time", async () => {
  const { chain, owner, outsider, token, vault } = await fixture();
  // Derived from chain time, not wall clock: the contract compares against
  // block.timestamp, and the two drift apart between fixture and assertion.
  const past = chain.time - 60n;
  const r = await vault.send(owner, "issueGrant", [outsider.hex, token.address, USDG6(1), past]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "ExpiryInPast");
});

test("the owner cannot be its own agent", async () => {
  const { owner, token, vault } = await fixture();
  const r = await vault.send(owner, "issueGrant", [owner.hex, token.address, USDG6(1), future()]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "AgentIsOwner");
});

test("spent survives re-issue, so history cannot be erased", async () => {
  const { owner, agent, merchant, token, vault } = await fixture();
  await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  await vault.send(owner, "issueGrant", [agent.hex, token.address, USDG6(100), future()]);
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], USDG6(10), "spent must not reset");
  assert.equal(await vault.call("remaining", [agent.hex]), USDG6(90));
});

// ------------------------------------------------------------------ gasless

test("payWithSig: the agent signs, the relayer pays the gas", async () => {
  const { agent, relayer, merchant, token, vault } = await fixture();
  const deadline = future();
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });
  const r = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), deadline, signature]);
  assert.equal(r.ok, true, r.error ?? vault.errorName(r) ?? "");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(7));
  assert.equal(await vault.call("nonces", [agent.hex]), 1n);
});

test("a relayed intent cannot be replayed", async () => {
  const { agent, relayer, merchant, token, vault } = await fixture();
  const deadline = future();
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });
  assert.equal((await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), deadline, signature])).ok, true);
  const again = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), deadline, signature]);
  assert.equal(again.ok, false, "the nonce must have moved");
  assert.equal(vault.errorName(again), "BadSignature");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(7), "paid once, not twice");
});

test("revoking kills intents signed before it", async () => {
  // The generation is inside the signed struct, so a revoke invalidates
  // anything already in flight rather than only future requests.
  const { owner, agent, relayer, merchant, token, vault } = await fixture();
  const deadline = future();
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });
  await vault.send(owner, "revokeGrant", [agent.hex]);
  const r = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), deadline, signature]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "BadSignature", "generation moved, so the signature no longer matches");
  assert.equal(await token.call("balanceOf", [merchant.hex]), 0n);
});

test("a signature from anyone but the agent is refused", async () => {
  const { agent, relayer, outsider, merchant, vault } = await fixture();
  const deadline = future();
  const { signature } = await signPay(outsider.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });
  const r = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), deadline, signature]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "BadSignature");
});

test("an expired signature is refused", async () => {
  const { chain, agent, relayer, merchant, vault } = await fixture();
  // Was flaky at -1 second off the wall clock: when the clock ticked between
  // building the fixture and computing this, the deadline landed exactly on
  // block.timestamp and "timestamp > deadline" was false. Chain time, with room.
  const past = chain.time - 60n;
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline: past, generation: 1,
  });
  const r = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), past, signature]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "SignatureExpired");
});

test("the signed amount is the amount paid", async () => {
  // Sign for 7, submit 70. The relayer is not trusted with the number.
  const { agent, relayer, merchant, token, vault } = await fixture();
  const deadline = future();
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });
  const r = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(70), deadline, signature]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "BadSignature");
  assert.equal(await token.call("balanceOf", [merchant.hex]), 0n);
});

test("the signed merchant is the merchant paid", async () => {
  const { owner, agent, relayer, merchant, outsider, token, vault } = await fixture();
  await vault.send(owner, "addMerchant", [outsider.hex]); // both are allowed payees
  const deadline = future();
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });
  // Redirecting to the other allowlisted payee must still fail: allowlisted is
  // not the same as authorised by this signature.
  const r = await vault.send(relayer, "payWithSig", [agent.hex, outsider.hex, USDG6(7), deadline, signature]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "BadSignature");
  assert.equal(await token.call("balanceOf", [outsider.hex]), 0n);
});

// ------------------------------------------------------------------- tokens

test("reentrancy during transfer cannot spend the headroom twice", async () => {
  const { chain, owner, agent, merchant } = await fixture();
  const evil = await chain.deploy(owner, "ReentrantToken", []);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);
  await evil.send(owner, "mint", [vault.address, USDG6(1000)]);
  await vault.send(owner, "issueGrant", [agent.hex, evil.address, USDG6(50), future()]);
  await vault.send(owner, "addMerchant", [merchant.hex]);
  await evil.send(owner, "arm", [vault.address, merchant.hex]);

  const r = await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  assert.equal(r.ok, true, "the outer payment should succeed");
  // The token re-entered mid-transfer and required the inner call to fail.
  // 10 spent, not 20.
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], USDG6(10), "the reentrant call must not have spent more headroom");
  assert.equal(await evil.call("balanceOf", [merchant.hex]), USDG6(10));
});

test("a token that returns nothing still works", async () => {
  // USDT-style. A strict bool decode would revert here and strand the vault.
  const { chain, owner, agent, merchant } = await fixture();
  const token = await chain.deploy(owner, "NoReturnToken", []);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);
  await token.send(owner, "mint", [vault.address, USDG6(1000)]);
  await vault.send(owner, "issueGrant", [agent.hex, token.address, USDG6(50), future()]);
  await vault.send(owner, "addMerchant", [merchant.hex]);

  const r = await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(10));
});

test("KNOWN LIMIT: a token that lies about transferring is not detected", async () => {
  // Pinned rather than fixed. The vault meters what it authorised, not what the
  // token actually did, so a malicious token can report success and move
  // nothing. A balance check before and after would catch it — and would also
  // break fee-on-transfer tokens, which move less on purpose. The real defence
  // is that the owner chooses the token, so this test exists to say that out
  // loud rather than to imply a guarantee the contract does not make.
  const { chain, owner, agent, merchant } = await fixture();
  const liar = await chain.deploy(owner, "LyingToken", []);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);
  await liar.send(owner, "mint", [vault.address, USDG6(1000)]);
  await vault.send(owner, "issueGrant", [agent.hex, liar.address, USDG6(50), future()]);
  await vault.send(owner, "addMerchant", [merchant.hex]);

  const r = await vault.send(agent, "pay", [merchant.hex, USDG6(10)]);
  assert.equal(r.ok, true);
  assert.equal(await liar.call("balanceOf", [merchant.hex]), 0n, "nothing actually moved");
  const g = await vault.call("grants", [agent.hex]);
  assert.equal(g[2], USDG6(10), "but the cap was still metered");
});

// ---------------------------------------------------------------- allowlist

test("the merchant list is capped and stays consistent through removals", async () => {
  const { chain, owner, vault } = await fixture();
  const made = [];
  for (let i = 0; i < 31; i++) {
    // 1 already added by the fixture, so 31 more fills it to MAX_MERCHANTS.
    const a = "0x" + (i + 2).toString(16).padStart(40, "0");
    made.push(a);
    const r = await vault.send(owner, "addMerchant", [a]);
    assert.equal(r.ok, true, `add ${i}`);
  }
  assert.equal(await vault.call("merchantCount", []), 32n);

  const over = await vault.send(owner, "addMerchant", ["0x" + "ff".repeat(20)]);
  assert.equal(over.ok, false);
  assert.equal(vault.errorName(over), "MerchantLimit");

  // Removal uses swap-and-pop; check the array does not corrupt.
  await vault.send(owner, "removeMerchant", [made[0]]);
  assert.equal(await vault.call("merchantCount", []), 31n);
  assert.equal(await vault.call("isMerchant", [made[0]]), false);
  const list = await vault.call("merchants", []);
  assert.equal(list.length, 31);
  assert.equal(new Set(list.map((a) => a.toLowerCase())).size, 31, "no duplicates after swap-and-pop");
  for (const a of made.slice(1)) {
    assert.equal(await vault.call("isMerchant", [a]), true, `${a} should still be allowed`);
  }
  void chain;
});

test("adding the same merchant twice does not duplicate it", async () => {
  const { owner, merchant, vault } = await fixture();
  assert.equal(await vault.call("merchantCount", []), 1n);
  await vault.send(owner, "addMerchant", [merchant.hex]);
  assert.equal(await vault.call("merchantCount", []), 1n);
});

// ---------------------------------------------------------------- ownership

test("ownership transfer is two-step", async () => {
  const { owner, outsider, vault } = await fixture();
  await vault.send(owner, "transferOwnership", [outsider.hex]);
  // Still the old owner until accepted — a mistyped address cannot brick it.
  assert.equal((await vault.call("owner", [])).toLowerCase(), owner.hex.toLowerCase());

  const notPending = await vault.send(owner, "acceptOwnership", []);
  assert.equal(notPending.ok, false);
  assert.equal(vault.errorName(notPending), "NotPendingOwner");

  assert.equal((await vault.send(outsider, "acceptOwnership", [])).ok, true);
  assert.equal((await vault.call("owner", [])).toLowerCase(), outsider.hex.toLowerCase());
});

// ---------------------------------------------------------------- expiry
// These only became testable once the harness controlled block.timestamp. Until
// then the VM sat at timestamp 0, every real unix expiry looked like the distant
// future, and the expiry checks were never exercised at all.

test("a grant stops working the moment it expires", async () => {
  const { chain, agent, merchant, token, vault } = await fixture();
  assert.equal((await vault.send(agent, "pay", [merchant.hex, USDG6(1)])).ok, true);

  chain.warp(YEAR + 1);

  const r = await vault.send(agent, "pay", [merchant.hex, USDG6(1)]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "GrantExpired");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(1), "only the pre-expiry payment landed");
});

test("remaining() reports zero once expired, not the leftover cap", async () => {
  // A stale number here would tell an operator the agent can still spend.
  const { chain, agent, vault } = await fixture();
  assert.equal(await vault.call("remaining", [agent.hex]), USDG6(50));
  chain.warp(YEAR + 1);
  assert.equal(await vault.call("remaining", [agent.hex]), 0n);
});

test("a signed intent cannot outlive the grant that authorised it", async () => {
  // The signature deadline and the grant expiry are separate clocks. A long
  // deadline must not survive the grant running out.
  const { chain, agent, relayer, merchant, token, vault } = await fixture();
  const deadline = chain.time + BigInt(10 * YEAR);
  const { signature } = await signPay(agent.wallet, vault.address, {
    agent: agent.hex, merchant: merchant.hex, amount: USDG6(7), nonce: 0n, deadline, generation: 1,
  });

  chain.warp(YEAR + 1);

  const r = await vault.send(relayer, "payWithSig", [agent.hex, merchant.hex, USDG6(7), deadline, signature]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "GrantExpired");
  assert.equal(await token.call("balanceOf", [merchant.hex]), 0n);
});

test("an expired grant can be brought back by revising the expiry", async () => {
  // Expiry is a pause, not a death sentence — revoke is the death sentence.
  const { chain, owner, agent, merchant, vault } = await fixture();
  chain.warp(YEAR + 1);
  assert.equal((await vault.send(agent, "pay", [merchant.hex, USDG6(1)])).ok, false);

  const newExpiry = BigInt(Number(chain.time) + YEAR);
  assert.equal((await vault.send(owner, "reviseGrant", [agent.hex, USDG6(50), newExpiry])).ok, true);
  assert.equal((await vault.send(agent, "pay", [merchant.hex, USDG6(1)])).ok, true);
});

test("reviseGrant cannot set an expiry that is already past", async () => {
  const { chain, owner, agent, vault } = await fixture();
  chain.warp(YEAR + 1);
  const stillPast = BigInt(Number(chain.time) - 60);
  const r = await vault.send(owner, "reviseGrant", [agent.hex, USDG6(50), stillPast]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "ExpiryInPast");
});
