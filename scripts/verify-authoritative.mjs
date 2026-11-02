#!/usr/bin/env node
// Consolidated release verification: content, deploy outputs and the complete server suite.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import config from "../shared/config.js";
import items from "../shared/config/items.js";
import store from "../shared/config/store.js";
import { AI_TYPES } from "../server/src/moomoo/modules/aiManager.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activeAnimals = new Set(config.server.animalSpawnPlan.map((entry) => entry.index));
assert.equal(items.weapons.length, 16, "16 weapons");
assert.equal(items.projectiles.length, 6, "6 projectile definitions");
assert.equal(items.list.length, 23, "23 items");
assert.equal(items.groups.length, 14, "14 item groups");
assert.equal(config.weaponVariants.length, 5, "5 weapon variants");
assert.equal(store.hats.length, 49, "49 hats");
assert.equal(store.accessories.length, 21, "21 accessories");
assert.equal(AI_TYPES.length, 15, "15 AI definitions");
assert.equal(activeAnimals.size, 13, "13 active animal types");
assert.equal(AI_TYPES[10].noTrap, true, "Yeti cannot be trapped");
assert.equal(AI_TYPES[10].hitRange > 0 && AI_TYPES[10].hitDelay > 0, true, "Yeti breaks structures through the melee path");
if (process.env.IS_SANDBOX !== "1") assert.equal(config.inSandbox, false, "production sandbox is off");
if (process.env.SANDBOX_UNLIMITED !== "1") assert.equal(config.unlimitedResources, false, "production resources are limited");
for (const required of ["dist/boot.js", "dist/official/index.html", "dist/official/assets/index-d71d2980.js", "dist/public/img/weapons/bow_1_d.png", "dist/public/css/fonts/material-icons.woff2"]) {
    assert.equal(fs.existsSync(path.join(ROOT, required)), true, `${required} must exist; run npm run build`);
}
console.log("Catalog and deploy-output assertions passed.");

const suite = spawnSync(process.execPath, ["--test", "server/"], { cwd: ROOT, stdio: "inherit", env: process.env });
if (suite.error) throw suite.error;
if (suite.status !== 0) process.exit(suite.status ?? 1);
console.log("VERIFY OK: catalog, build outputs and the complete authoritative server suite passed.");
