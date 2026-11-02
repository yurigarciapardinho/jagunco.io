#!/usr/bin/env node
// BUILD TOUCH MODULE
// The official client lazy-loads ./index-d71d2980.js (relative to /assets/) the first
// time a touch session enters a game, expecting a default export whose
// create({ zone }) returns a joystick manager with the classic nipplejs API:
// manager.on("start" | "move" | "end", (evt, data) => ...) with data.force and
// data.angle.radian on "move". That chunk never shipped with the saved page, so it is
// rebuilt here from the maintained nipplejs package (package.json dependency),
// bundled locally as ESM — no CDN, no joystick reimplementation.
//
// nipplejs 1.x calls handlers with a single { type, target, data } argument; the
// official bundle was built against the classic two-argument (evt, data) signature,
// so the entry below adapts manager.on before handing the manager out.
//
// Must run AFTER tools/build-official-client.mjs, which wipes dist/official.
// Exits non-zero (failing the build) when the chunk is not produced.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist/official/assets");
const OUT_FILE = path.join(OUT_DIR, "index-d71d2980.js");

const ENTRY = String.raw`
// nipplejs 1.x trigger() invokes handlers as handler({ type, target, data }); the
// official client uses the classic signature handler(evt, data). Adapt on() so the
// manager handed to the game speaks the classic API while every joystick, event and
// data object (force, angle.radian, vector, ...) still comes from nipplejs itself.
// The client also reads manager.ids.length (classic: array of the identifiers being
// driven); 1.x keeps them as the keys of manager.actives, exposed here as a live view.
import nipplejs from "nipplejs";

function classicEvents(manager) {
    const on = manager.on.bind(manager);
    manager.on = (types, handler) => on(types, (evt) => handler.call(manager, evt, evt ? evt.data : undefined));
    Object.defineProperty(manager, "ids", { get: () => [...manager.actives.keys()] });
    return manager;
}

export default {
    ...nipplejs,
    create: (options) => classicEvents(nipplejs.create(options))
};
`;

if (!fs.existsSync(OUT_DIR)) {
    console.error(`touch module: ${path.relative(ROOT, OUT_DIR)} is missing - run tools/build-official-client.mjs first`);
    process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "node_modules/nipplejs/dist/index.mjs"))) {
    console.error("touch module: nipplejs is not installed - run npm install first");
    process.exit(1);
}

await esbuild.build({
    stdin: { contents: ENTRY, loader: "js", resolveDir: ROOT, sourcefile: "touch-module-entry.js" },
    outfile: OUT_FILE,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    logLevel: "silent"
});

// The client does (await import("./index-d71d2980.js")).default.create(...): the chunk
// must exist, be non-trivial and expose a default export.
if (!fs.existsSync(OUT_FILE)) {
    console.error("touch module: esbuild finished but dist/official/assets/index-d71d2980.js was not written");
    process.exit(1);
}
const built = fs.readFileSync(OUT_FILE, "utf8");
if (built.length < 5000 || !/export\s*\{[\s\S]*?\bas default\b/.test(built)) {
    console.error("touch module: built chunk has no default export - refusing to ship it");
    process.exit(1);
}
console.log(`touch module -> ${path.relative(ROOT, OUT_FILE)} (${(built.length / 1024).toFixed(1)} KB, nipplejs bundled)`);
