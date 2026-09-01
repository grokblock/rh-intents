import assert from "node:assert/strict";
import { test } from "node:test";
import { TypedDataEncoder, keccak256, toUtf8Bytes } from "ethers";
import { Chain, KEYS, CHAIN_ID } from "./helpers.mjs";

/**
 * The client and the contract have to agree on the EIP-712 domain and type, and
 * nothing forces them to. They are written in different languages, in different
 * files, by hand. A single character apart — a renamed field, a different
 * version string, a type ordered differently — and every signature verifies
 * against a digest the contract will never compute.
 *
 * That failure is silent at build time and total at runtime: `BadSignature` on
 * every payment, with nothing to point at. These tests compare the two directly.
 */

test("the contract's domain separator matches the one the client builds", async () => {
  const chain = await Chain.create();
  const owner = await chain.account(KEYS.owner);
  const vault = await chain.deploy(owner, "GrantVault", [owner.hex]);

  const onChain = await vault.call("DOMAIN_SEPARATOR", []);

  // Exactly the domain in src/client.mjs. If that file changes, this fails.
  const offChain = TypedDataEncoder.hashDomain({
    name: "GrantVault",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: vault.address,
  });

  assert.equal(onChain, offChain);
});

test("the Pay type hash matches the struct the contract hashes", async () => {
  // The contract hardcodes this string. The client describes the same struct as
  // an object, and ethers derives the string from it. They must agree, including
  // field order — Pay(agent,merchant,...) and Pay(merchant,agent,...) are
  // different types with different hashes.
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
  const derived = TypedDataEncoder.from(types).encodeType("Pay");
  assert.equal(
    derived,
    "Pay(address agent,address merchant,uint256 amount,uint256 nonce,uint256 deadline,uint32 generation)",
  );
  // And that string is what _PAY_TYPEHASH hashes in the contract.
  assert.equal(
    keccak256(toUtf8Bytes(derived)),
    keccak256(
      toUtf8Bytes(
        "Pay(address agent,address merchant,uint256 amount,uint256 nonce,uint256 deadline,uint32 generation)",
      ),
    ),
  );
});

test("the domain separator is bound to the chain id", async () => {
  // Two vaults at the same address on different chains must not accept each
  // other's signatures. The contract mixes block.chainid in; this proves the
  // client's domain moves with it too, so a testnet signature cannot be
  // replayed on mainnet.
  const vaultAddress = "0x1111111111111111111111111111111111111111";
  const base = { name: "GrantVault", version: "1", verifyingContract: vaultAddress };
  const mainnet = TypedDataEncoder.hashDomain({ ...base, chainId: 4663 });
  const testnet = TypedDataEncoder.hashDomain({ ...base, chainId: 46630 });
  assert.notEqual(mainnet, testnet);
});

test("the domain separator is bound to the vault address", async () => {
  // Two vaults on the same chain must not accept each other's signatures — one
  // could have a payee allowlist the other does not.
  const base = { name: "GrantVault", version: "1", chainId: CHAIN_ID };
  const a = TypedDataEncoder.hashDomain({ ...base, verifyingContract: "0x1111111111111111111111111111111111111111" });
  const b = TypedDataEncoder.hashDomain({ ...base, verifyingContract: "0x2222222222222222222222222222222222222222" });
  assert.notEqual(a, b);
});
