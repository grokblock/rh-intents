import assert from "node:assert/strict";
import { test } from "node:test";
import { Chain, KEYS } from "./helpers.mjs";

const DAY = 24 * 3600;
const YEAR = 365 * DAY;
const USDG6 = (n) => BigInt(Math.round(n * 1e6));

async function fixture({ cap = USDG6(500) } = {}) {
  const chain = await Chain.create();
  const owner = await chain.account(KEYS.owner);
  const agent = await chain.account(KEYS.agent);
  const keeper = await chain.account(KEYS.relayer);
  const merchant = await chain.account(KEYS.merchant);
  const outsider = await chain.account(KEYS.outsider);

  const token = await chain.deploy(owner, "MockToken", [6]);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);
  await token.send(owner, "mint", [vault.address, USDG6(10000)]);
  await vault.send(owner, "issueGrant", [agent.hex, token.address, cap, BigInt(Number(chain.time) + 10 * YEAR)]);
  await vault.send(owner, "addMerchant", [merchant.hex]);

  return { chain, owner, agent, keeper, merchant, outsider, token, vault };
}

async function create(vault, owner, agent, merchant, amount = USDG6(15), period = 30 * DAY) {
  const r = await vault.send(owner, "createSubscription", [agent.hex, merchant.hex, amount, period, 0]);
  assert.equal(r.ok, true, vault.errorName(r) ?? r.error ?? "");
  return 1n; // first subscription in a fresh fixture
}

test("a subscription charges its period once", async () => {
  const { owner, agent, keeper, merchant, token, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);

  const [due, period] = await vault.call("isDue", [id]);
  assert.equal(due, true);
  assert.equal(period, 0n);

  const r = await vault.send(keeper, "paySubscription", [id, 0]);
  assert.equal(r.ok, true, vault.errorName(r) ?? "");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(15));

  const s = await vault.call("subscriptions", [id]);
  assert.equal(s[5], 0n, "lastPaidPeriod");
  assert.equal(s[6], 1n, "payments");
});

test("THE guarantee: the same period cannot be charged twice", async () => {
  // A scheduler that crashes after sending and retries on restart must not be
  // able to double-charge. The counter advances in the same transaction that
  // moves the money, so the second attempt has nothing left to do.
  const { owner, agent, keeper, merchant, token, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);

  assert.equal((await vault.send(keeper, "paySubscription", [id, 0])).ok, true);
  const again = await vault.send(keeper, "paySubscription", [id, 0]);
  assert.equal(again.ok, false);
  assert.equal(vault.errorName(again), "AlreadyPaidThisPeriod");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(15), "charged once");

  // Ten more retries change nothing.
  for (let i = 0; i < 10; i++) await vault.send(keeper, "paySubscription", [id, 0]);
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(15));
});

test("the next period becomes payable, and only when it arrives", async () => {
  const { chain, owner, agent, keeper, merchant, token, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);
  await vault.send(keeper, "paySubscription", [id, 0]);

  chain.warp(29 * DAY); // still inside period 0
  assert.equal((await vault.call("isDue", [id]))[0], false);
  const early = await vault.send(keeper, "paySubscription", [id, 1]);
  assert.equal(early.ok, false);
  assert.equal(vault.errorName(early), "PeriodMismatch");

  chain.warp(2 * DAY); // now in period 1
  const [due, period] = await vault.call("isDue", [id]);
  assert.equal(due, true);
  assert.equal(period, 1n);
  assert.equal((await vault.send(keeper, "paySubscription", [id, 1])).ok, true);
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(30));
});

test("missed periods are NOT backfilled", async () => {
  // Offline for three months pays the current period, not three of them. Waking
  // to a surprise triple charge is a worse failure than a missed month.
  const { chain, owner, agent, keeper, merchant, token, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);
  await vault.send(keeper, "paySubscription", [id, 0]);

  chain.warp(90 * DAY); // periods 1 and 2 went by unpaid

  const [, period] = await vault.call("isDue", [id]);
  assert.equal(period, 3n);
  assert.equal((await vault.send(keeper, "paySubscription", [id, 3])).ok, true);
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(30), "two charges total, not four");

  // And the skipped periods stay unpayable — no catching up later.
  for (const p of [1, 2]) {
    const r = await vault.send(keeper, "paySubscription", [id, p]);
    assert.equal(r.ok, false, `period ${p} must not be backfillable`);
  }
  // The gap is visible rather than hidden.
  const s = await vault.call("subscriptions", [id]);
  assert.equal(s[6], 2n, "payments counts what actually happened");
});

test("asserting the wrong period fails loudly instead of paying the wrong cycle", async () => {
  const { owner, agent, keeper, merchant, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);
  const r = await vault.send(keeper, "paySubscription", [id, 7]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "PeriodMismatch");
});

test("cancelling stops it immediately, and is owner-only", async () => {
  const { chain, owner, agent, keeper, merchant, outsider, token, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);
  await vault.send(keeper, "paySubscription", [id, 0]);

  const notOwner = await vault.send(outsider, "cancelSubscription", [id]);
  assert.equal(notOwner.ok, false);
  assert.equal(vault.errorName(notOwner), "NotOwner");

  assert.equal((await vault.send(owner, "cancelSubscription", [id])).ok, true);
  chain.warp(31 * DAY);
  const after = await vault.send(keeper, "paySubscription", [id, 1]);
  assert.equal(after.ok, false);
  assert.equal(vault.errorName(after), "SubscriptionInactive");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(15));
  assert.equal((await vault.call("isDue", [id]))[0], false);
});

test("removing the merchant stops the subscription without touching it", async () => {
  // Three scopes of control, all in the human's hands: cancel this one, remove
  // the payee to stop everything to them, revoke the grant to stop everything.
  const { chain, owner, agent, keeper, merchant, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);
  await vault.send(keeper, "paySubscription", [id, 0]);

  await vault.send(owner, "removeMerchant", [merchant.hex]);
  chain.warp(31 * DAY);
  const r = await vault.send(keeper, "paySubscription", [id, 1]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "PayeeNotAllowed");
});

test("revoking the grant stops the subscription too", async () => {
  const { chain, owner, agent, keeper, merchant, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);
  await vault.send(keeper, "paySubscription", [id, 0]);

  await vault.send(owner, "revokeGrant", [agent.hex]);
  chain.warp(31 * DAY);
  const r = await vault.send(keeper, "paySubscription", [id, 1]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "GrantRevoked");
});

test("a subscription cannot outrun the grant cap", async () => {
  // The cap is the real ceiling. A subscription is not a way around it.
  const { chain, owner, agent, keeper, merchant, token, vault } = await fixture({ cap: USDG6(25) });
  const id = await create(vault, owner, agent, merchant, USDG6(15));
  assert.equal((await vault.send(keeper, "paySubscription", [id, 0])).ok, true);

  chain.warp(31 * DAY);
  const r = await vault.send(keeper, "paySubscription", [id, 1]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "CapExceeded");
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(15));

  // And the failed charge must not have advanced the period counter — the whole
  // transaction reverted, so a top-up makes period 1 payable again.
  await vault.send(owner, "reviseGrant", [agent.hex, USDG6(100), BigInt(Number(chain.time) + YEAR)]);
  assert.equal((await vault.send(keeper, "paySubscription", [id, 1])).ok, true);
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(30));
});

test("a period shorter than a day is refused", async () => {
  const { owner, agent, merchant, vault } = await fixture();
  const r = await vault.send(owner, "createSubscription", [agent.hex, merchant.hex, USDG6(1), 3600, 0]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "PeriodTooShort");
});

test("a subscription cannot name a payee the owner has not approved", async () => {
  const { owner, agent, outsider, vault } = await fixture();
  const r = await vault.send(owner, "createSubscription", [agent.hex, outsider.hex, USDG6(1), 30 * DAY, 0]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "PayeeNotAllowed");
});

test("only the owner can create one", async () => {
  const { agent, outsider, merchant, vault } = await fixture();
  const r = await vault.send(outsider, "createSubscription", [agent.hex, merchant.hex, USDG6(1), 30 * DAY, 0]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "NotOwner");
});

test("a future start date delays the first charge", async () => {
  const { chain, owner, agent, keeper, merchant, vault } = await fixture();
  const start = BigInt(Number(chain.time) + 10 * DAY);
  await vault.send(owner, "createSubscription", [agent.hex, merchant.hex, USDG6(15), 30 * DAY, start]);

  assert.equal((await vault.call("isDue", [1n]))[0], false, "not due before the start date");
  const early = await vault.send(keeper, "paySubscription", [1n, 0]);
  assert.equal(early.ok, false);
  assert.equal(vault.errorName(early), "NotStarted");

  chain.warp(11 * DAY);
  assert.equal((await vault.call("isDue", [1n]))[0], true);
  assert.equal((await vault.send(keeper, "paySubscription", [1n, 0])).ok, true);
});

test("anyone may trigger a charge, and can only cause what the owner authorised", async () => {
  // Permissionless on purpose: it removes the failure mode where a subscription
  // lapses because the bot was offline. Every parameter that decides where the
  // money goes was fixed by the owner, so a stranger calling it is harmless.
  const { owner, agent, outsider, merchant, token, vault } = await fixture();
  const id = await create(vault, owner, agent, merchant);

  const r = await vault.send(outsider, "paySubscription", [id, 0]);
  assert.equal(r.ok, true, "a stranger may trigger it");
  // ...and the money still went to the owner's merchant, not the caller.
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(15));
  assert.equal(await token.call("balanceOf", [outsider.hex]), 0n);
});

test("an unknown subscription id is refused", async () => {
  const { keeper, vault } = await fixture();
  const r = await vault.send(keeper, "paySubscription", [999n, 0]);
  assert.equal(r.ok, false);
  assert.equal(vault.errorName(r), "SubscriptionMissing");
});

test("two subscriptions to the same merchant stay independent", async () => {
  const { owner, agent, keeper, merchant, token, vault } = await fixture();
  await vault.send(owner, "createSubscription", [agent.hex, merchant.hex, USDG6(15), 30 * DAY, 0]);
  await vault.send(owner, "createSubscription", [agent.hex, merchant.hex, USDG6(5), 30 * DAY, 0]);

  assert.equal((await vault.send(keeper, "paySubscription", [1n, 0])).ok, true);
  assert.equal((await vault.send(keeper, "paySubscription", [2n, 0])).ok, true);
  assert.equal(await token.call("balanceOf", [merchant.hex]), USDG6(20));

  // Cancelling one must not touch the other.
  await vault.send(owner, "cancelSubscription", [1n]);
  assert.equal((await vault.call("isDue", [2n]))[0], false, "period 0 already paid on #2");
  const s2 = await vault.call("subscriptions", [2n]);
  assert.equal(s2[7], true, "#2 is still active");
});
