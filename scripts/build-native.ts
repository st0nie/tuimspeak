#!/usr/bin/env bun
/**
 * Builds the two native helpers into native/target/release/:
 *   ts-connector  (webspeak3 submodule, unmodified)
 *   tuim-audio    (our audio sidecar)
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const target = join(root, "native", "target");
const connectorManifest = join(root, "native", "webspeak3", "connector", "Cargo.toml");
const audioManifest = join(root, "native", "tuim-audio", "Cargo.toml");

if (!existsSync(join(root, "native", "webspeak3", "tsclientlib", "tsclientlib", "Cargo.toml"))) {
  console.error("Submodules are missing. Run: git submodule update --init --recursive");
  process.exit(1);
}

function cargo(manifest: string, label: string) {
  console.log(`\n==> Building ${label}`);
  const result = spawnSync("cargo", ["build", "--release", "--manifest-path", manifest], {
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: target,
      // audiopus_sys bundles an old opus CMakeLists; newer CMake needs this to accept it.
      CMAKE_POLICY_VERSION_MINIMUM: process.env.CMAKE_POLICY_VERSION_MINIMUM ?? "3.5",
    },
  });
  if (result.error) {
    console.error(`Could not run cargo: ${result.error.message}. Install Rust from https://rustup.rs`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

cargo(connectorManifest, "ts-connector");
cargo(audioManifest, "tuim-audio");
console.log(`\nDone: ${join(target, "release")}`);
