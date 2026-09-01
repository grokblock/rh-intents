/**
 * A real EVM, in process. No node, no network, no faucet.
 *
 * Robinhood Chain's testnet has no faucet we can reach and no USDG deployed, so
 * "test on testnet" is not available yet. Running the actual EVM here means the
 * contract is exercised against real execution semantics — reverts, reentrancy,
 * gas — rather than against a mock of them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VM } from "@ethereumjs/vm";
import { Common, Chain as EjsChain, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Block } from "@ethereumjs/block";
import { Account, Address, privateToAddress, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { Interface, Wallet, TypedDataEncoder } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "out");

/** Robinhood Chain mainnet, so EIP-712 domain separators match what deploys. */
export const CHAIN_ID = 4663;

export function artifact(name) {
  return JSON.parse(readFileSync(join(outDir, `${name}.json`), "utf8"));
}

export class Chain {
  constructor(vm, common) {
    this.vm = vm;
    this.common = common;
    this.nonces = new Map();
    // The VM's genesis block sits at timestamp 0, which would make every real
    // unix expiry look like the distant future and quietly disable every
    // deadline check in the contract. Start at wall clock instead.
    this.time = BigInt(Math.floor(Date.now() / 1000));
  }

  /** Move block.timestamp forward, to exercise expiry rather than assume it. */
  warp(seconds) {
    this.time += BigInt(seconds);
  }

  _block() {
    return Block.fromBlockData(
      { header: { timestamp: this.time, gasLimit: 30_000_000n, baseFeePerGas: 7n, number: 1n } },
      { common: this.common, skipConsensusFormatValidation: true },
    );
  }

  static async create() {
    const common = new Common({ chain: EjsChain.Mainnet, hardfork: Hardfork.Shanghai });
    common.chainId = () => BigInt(CHAIN_ID);
    const vm = await VM.create({ common });
    return new Chain(vm, common);
  }

  /** A funded account with a known key, so ethers can sign EIP-712 for it. */
  async account(privHex) {
    const priv = hexToBytes(privHex);
    const addr = new Address(privateToAddress(priv));
    await this.vm.stateManager.putAccount(
      addr,
      Account.fromAccountData({ nonce: 0n, balance: 10n ** 20n }),
    );
    return { priv, address: addr, hex: addr.toString(), wallet: new Wallet(privHex) };
  }

  async _send(from, to, data, value = 0n) {
    const n = this.nonces.get(from.hex) ?? 0n;
    const tx = LegacyTransaction.fromTxData(
      {
        nonce: n,
        gasPrice: 10n, // must clear the genesis baseFeePerGas of 7
        gasLimit: 8_000_000n,
        to: to ? Address.fromString(to) : undefined,
        value,
        data: hexToBytes(data),
      },
      { common: this.common },
    ).sign(from.priv);
    this.nonces.set(from.hex, n + 1n);
    return await this.vm.runTx({
      tx,
      block: this._block(),
      skipBalance: true,
      skipBlockGasLimitValidation: true,
    });
  }

  async deploy(from, name, args = []) {
    const art = artifact(name);
    const iface = new Interface(art.abi);
    const data = art.bytecode + iface.encodeDeploy(args).slice(2);
    const res = await this._send(from, undefined, data);
    if (res.execResult.exceptionError) {
      throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error}`);
    }
    return new Contract(this, bytesToHex(res.createdAddress.bytes), art.abi);
  }
}

export class Contract {
  constructor(chain, address, abi) {
    this.chain = chain;
    this.address = address;
    this.iface = new Interface(abi);
  }

  /** Send a transaction. Returns { ok, error, ... } — never throws on revert. */
  async send(from, fn, args = []) {
    const data = this.iface.encodeFunctionData(fn, args);
    const res = await this.chain._send(from, this.address, data);
    const err = res.execResult.exceptionError;
    return {
      ok: !err,
      error: err ? err.error : null,
      returnValue: bytesToHex(res.execResult.returnValue),
      logs: res.execResult.logs ?? [],
      gasUsed: res.totalGasSpent,
    };
  }

  /** eth_call equivalent. Throws on revert: a read that reverts is a test bug. */
  async call(fn, args = []) {
    const data = this.iface.encodeFunctionData(fn, args);
    const res = await this.chain.vm.evm.runCall({
      block: this.chain._block(),
      to: Address.fromString(this.address),
      caller: Address.fromString("0x0000000000000000000000000000000000000001"),
      origin: Address.fromString("0x0000000000000000000000000000000000000001"),
      data: hexToBytes(data),
      gasLimit: 8_000_000n,
    });
    if (res.execResult.exceptionError) {
      throw new Error(`call ${fn} reverted: ${res.execResult.exceptionError.error}`);
    }
    const decoded = this.iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
    return decoded.length === 1 ? decoded[0] : decoded;
  }

  /** Decode a custom-error selector, so tests assert the reason not just failure. */
  errorName(result) {
    if (!result.returnValue || result.returnValue.length < 10) return null;
    try {
      return this.iface.parseError(result.returnValue)?.name ?? null;
    } catch {
      return null;
    }
  }
}

/** Sign a Pay intent the way the client will. */
export async function signPay(wallet, vaultAddress, { agent, merchant, amount, nonce, deadline, generation }) {
  const domain = { name: "GrantVault", version: "1", chainId: CHAIN_ID, verifyingContract: vaultAddress };
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
  const value = { agent, merchant, amount, nonce, deadline, generation };
  return {
    signature: await wallet.signTypedData(domain, types, value),
    digest: TypedDataEncoder.hash(domain, types, value),
  };
}

export const KEYS = {
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  relayer: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  merchant: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  outsider: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
};
