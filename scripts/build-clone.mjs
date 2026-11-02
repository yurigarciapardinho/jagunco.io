#!/usr/bin/env node
// BUILD CLONE
// Produces the deployable bundle the platform runs:
//
//   dist/boot.js      server/src/index.js + shared/ + deps, bundled by esbuild
//                     (run with: node dist/boot.js, PORT/HOST env, defaults 3000 / 0.0.0.0)
//   dist/official/    official client patched to talk to this server
//                     (tools/build-official-client.mjs, run as a child process)
//   dist/public/      static game assets: client/public/ + the extra fonts/art in public/
//
// Any step that fails aborts the build with a non-zero exit code.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

// ---------------------------------------------------------------- official client
console.log("== official client ==");
const official = spawnSync(process.execPath, [path.join(ROOT, "tools/build-official-client.mjs")], {
    cwd: ROOT,
    stdio: "inherit"
});
if (official.error) throw official.error;
if (official.status !== 0) {
    console.error(`tools/build-official-client.mjs exited with code ${official.status}`);
    process.exit(official.status ?? 1);
}

// ---------------------------------------------------------------- touch joysticks
// The official client lazy-loads assets/index-d71d2980.js on touch devices; it must be
// rebuilt after the official client step (which wipes dist/official).
console.log("== touch module ==");
const touch = spawnSync(process.execPath, [path.join(ROOT, "tools/build-touch-module.mjs")], {
    cwd: ROOT,
    stdio: "inherit"
});
if (touch.error) throw touch.error;
if (touch.status !== 0) {
    console.error(`tools/build-touch-module.mjs exited with code ${touch.status}`);
    process.exit(touch.status ?? 1);
}

// ---------------------------------------------------------------- server bundle
console.log("== server bundle ==");
await esbuild.build({
    entryPoints: [path.join(ROOT, "server/src/index.js")],
    outfile: path.join(DIST, "boot.js"),
    platform: "node",
    target: "node20",
    format: "esm",
    bundle: true,
    // optional native ws addons: ws works (slower) without them
    external: ["bufferutil", "utf-8-validate"],
    // CJS deps (express, ws, msgpack-lite, bad-words) are inlined; give any
    // left-over require() of an external package a working require.
    // Distinct local name: bundled sources (server/src/persistence/mysqlDriver.js)
    // also import { createRequire } and esbuild keeps that import verbatim.
    banner: { js: "import { createRequire as __bootCreateRequire } from 'module';const require = __bootCreateRequire(import.meta.url);" },
    logLevel: "info"
});

// ---------------------------------------------------------------- static assets
console.log("== static assets ==");
// dist/boot.js is ESM; the root package.json is CommonJS (shared/ config is CJS)
fs.writeFileSync(path.join(DIST, "package.json"), JSON.stringify({ type: "module" }) + "\n");
const PUBLIC_OUT = path.join(DIST, "public");
fs.rmSync(PUBLIC_OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "client/public"), PUBLIC_OUT, { recursive: true, dereference: false });
// the Jagunco fonts only live in the top-level public/; overlay it (art is the same
// files that are already in client/public/art)
fs.cpSync(path.join(ROOT, "public"), PUBLIC_OUT, { recursive: true, dereference: false });

// ---------------------------------------------------------------- sanity check
for (const required of ["boot.js", "official/index.html", "official/assets", "official/assets/index-d71d2980.js", "public/img", "public/manifest.json"]) {
    if (!fs.existsSync(path.join(DIST, required))) {
        console.error(`build incomplete: dist/${required} is missing`);
        process.exit(1);
    }
}
const bundled = fs.readdirSync(path.join(DIST, "official/assets")).filter(f => /^index-[\w-]+\.js$/.test(f));
console.log(`done -> dist/boot.js, dist/official (${bundled[0] || "no bundle?"}), dist/public`);
