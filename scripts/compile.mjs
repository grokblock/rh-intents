#!/usr/bin/env node
/** Compile contracts/ to out/. Fails on any warning that matters, not just errors. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "contracts");
const outDir = join(root, "out");

const sources = {};
for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: readFileSync(join(srcDir, f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // swapWithSig takes eight parameters and the legacy pipeline runs out of
    // stack slots on it. viaIR is the documented fix and produces the same
    // semantics through a different codegen path; the alternative was to
    // contort the signature into a struct purely to please the old backend.
    viaIR: true,
    // Shanghai, not Cancun. Cancun emits MCOPY/TSTORE, and anything that cannot
    // execute those turns a working contract into "invalid opcode" at runtime.
    // Shanghai is universally supported on Arbitrum-derived chains, and this
    // contract gains nothing from the newer opcodes.
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
let fatal = 0;
for (const e of out.errors ?? []) {
  // Licence chatter is noise; everything else gets shown.
  if (/SPDX/.test(e.message)) continue;
  console.log(`${e.severity.toUpperCase()}: ${e.formattedMessage.trim()}\n`);
  if (e.severity === "error") fatal++;
}
if (fatal) {
  console.log(`${fatal} error(s).`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const EIP170 = 24576; // the deployed-bytecode ceiling, in bytes
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    const deployed = c.evm.deployedBytecode.object.length / 2;
    writeFileSync(
      join(outDir, `${name}.json`),
      JSON.stringify(
        {
          abi: c.abi,
          bytecode: "0x" + c.evm.bytecode.object,
          deployedBytecode: "0x" + c.evm.deployedBytecode.object,
        },
        null,
        2,
      ),
    );
    const pct = ((deployed / EIP170) * 100).toFixed(1);
    console.log(
      `  ${name.padEnd(14)} ${String(deployed).padStart(6)} bytes  ${pct}% of the EIP-170 limit` +
        (deployed > EIP170 ? "  <-- OVER" : ""),
    );
    if (deployed > EIP170) process.exitCode = 1;
  }
  void file;
}
console.log("\nCompiled to out/.");
