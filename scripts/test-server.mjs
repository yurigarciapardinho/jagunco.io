#!/usr/bin/env node
// Resolve test files explicitly so supported Node versions run the same suite.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules") collect(file);
        else if (entry.isFile() && /\.test\.[cm]?js$/.test(entry.name)) files.push(file);
    }
}
collect(path.join(ROOT, "server"));
files.sort();
if (!files.length) {
    console.error("No server tests found.");
    process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
