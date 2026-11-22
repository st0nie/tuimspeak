#!/usr/bin/env bun
/**
 * Compiles tuimspeak into one self-contained executable (architecture §12):
 *   bun scripts/build.ts [--target bun-linux-x64-baseline] [--outfile dist/tuimspeak]
 * The target names Bun's official runtime, so the binary does not depend on
 * the build machine's Bun.
 */
import type { BunPlugin } from "bun";
import { parseArgs } from "node:util";

const hostTarget = `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string", default: hostTarget },
    outfile: { type: "string", default: "dist/tuimspeak" },
  },
});

// Ink loads React DevTools only when DEV=true and the package resolves at
// runtime, but the bundler hoists the import to startup. Give it an empty module.
const noDevtools: BunPlugin = {
  name: "no-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

const result = await Bun.build({
  entrypoints: ["src/main.tsx"],
  compile: { target: values.target as Bun.Build.CompileTarget, outfile: values.outfile },
  minify: true,
  sourcemap: "linked",
  plugins: [noDevtools],
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${values.outfile} (${values.target})`);
