// DATA INTEGRITY (real shared tables, measured values)
// Acceptance coverage (briefing §3, §4, §5, §11 items 8, 10, 11, 13): the rules the
// behavioural suites rely on, asserted directly against the shipped data.

import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { items } from "./items.js";
import { hats, accessories } from "./store.js";
import { AI_TYPES } from "./aiManager.js";

test("config: core world and combat constants match the reference", () => {
    assert.equal(config.mapScale, 14400);
    assert.equal(config.riverWidth, 724);
    assert.equal(config.snowBiomeTop, 2400);
    assert.equal(config.snowSpeed, 0.75);
    assert.equal(config.playerScale, 35);
    assert.equal(config.maxAge, 100);
    assert.ok(Math.abs(config.gatherAngle - Math.PI / 2.6) < 1e-12, "melee arc ~69.3 deg");
    assert.ok(Math.abs(config.shieldAngle - Math.PI / 3) < 1e-12, "shield arc 60 deg");
});

test("weapon variants: exact XP ladder, emerald members-only with poison+lifesteal", () => {
    const v = config.weaponVariants;
    assert.deepEqual(v.map(x => [x.id, x.xp, x.val]), [
        [0, 0, 1], [1, 3000, 1.1], [2, 7000, 1.18], [3, 12000, 1.18], [4, 30000, 1.18]
    ]);
    assert.equal(v[3].poison, true, "ruby poisons");
    assert.equal(v[4].membersOnly, true, "emerald is members-only");
    assert.equal(v[4].poison, true);
    assert.equal(v[4].lifesteal, 0.15);
});

test("weapons: ages inside maxAge, prerequisites resolve, projectiles exist", () => {
    for (const w of items.weapons) {
        if (w.age != undefined) assert.ok(w.age >= 1 && w.age <= config.maxAge, `weapon ${w.id} age valid`);
        if (w.pre != undefined) {
            assert.ok(items.weapons[w.pre], `weapon ${w.id} pre ${w.pre} exists`);
            assert.ok(w.pre < w.id, "prerequisite comes earlier in the list");
        }
        if (w.projectile != undefined) {
            assert.ok(items.projectiles[w.projectile], `weapon ${w.id} projectile ${w.projectile} exists`);
        }
        if (w.gather != undefined || w.projectile != undefined) {
            assert.ok(w.speed > 0, `weapon ${w.id} has a cooldown`);
        }
    }
    // the shield weapon really shields
    assert.equal(items.weapons[11].shield, 0.2, "wooden shield blocks to 20%");
});

test("items: groups/limits valid, structure flags coherent with the engine rules", () => {
    for (const item of items.list) {
        assert.ok(item.group && typeof item.group.id === "number", `item ${item.id} has a group`);
        assert.ok(!item.group.limit || item.group.limit > 0, `item ${item.id} limit positive`);
        for (let i = 0; i < item.req.length; i += 2) {
            assert.ok(config.resourceTypes.includes(item.req[i]), `item ${item.id} req resource valid`);
        }
        if (item.pre != undefined) assert.ok(items.list[item.pre], `item ${item.id} pre resolves`);
    }

    const byName = n => items.list.find(i => i.name === n);
    assert.equal(byName("platform").id, 18, "platform id 18 matches the river exception in checkItemLocation");
    assert.equal(byName("spikes").dmg, 20, "reference spike damage");
    assert.ok(byName("pit trap").trap && byName("pit trap").ignoreCollision, "pit trap flags");
    assert.ok(byName("boost pad").boostSpeed > 0, "boost pad pushes");
    assert.ok(byName("healing pad").healCol > 0, "healing pad heals");
    assert.ok(byName("teleporter").teleport, "teleporter flag");
    assert.ok(byName("spawn pad").spawnPoint, "spawn pad flag");
    const turret = byName("turret");
    assert.ok(turret.doUpdate && turret.projectile != undefined && turret.shootRange > 0 && turret.shootRate > 0,
        "turret is a live structure with range and cadence");
    assert.ok(byName("blocker").blocker > 0, "blocker denies building around it");
    assert.ok(byName("wood wall").projDmg, "wood wall takes projectile damage");
});

test("store: unique ids, sane prices, Shame! is not for sale", () => {
    const ids = new Set();
    for (const h of hats) {
        assert.ok(!ids.has(h.id), `hat id ${h.id} unique`);
        ids.add(h.id);
        assert.ok(h.price >= 0, `hat ${h.id} price non-negative`);
    }
    const shame = hats.find(h => h.id === 45);
    assert.ok(shame && shame.dontSell, "Shame! hat cannot be bought");
    for (const a of accessories) {
        assert.ok(a.id >= 0 && a.price >= 0, `accessory ${a.id} sane`);
    }
});

test("AI table: passives passive, hostiles hostile, bosses flagged, drops valid", () => {
    for (const a of AI_TYPES) {
        assert.ok(a.health > 0 && a.speed >= 0 && a.scale > 0, `${a.name} has base stats`);
        assert.ok(a.killScore > 0, `${a.name} pays a kill score`);
        if (a.drop) for (let i = 0; i < a.drop.length; i += 2) {
            assert.ok(config.resourceTypes.includes(a.drop[i]), `${a.name} drop resource valid`);
        }
    }
    const byId = id => AI_TYPES.find(a => a.id === id);
    for (const id of [0, 1, 12]) { // cow, pig, sheep
        assert.ok(!byId(id).hostile && !byId(id).chargePlayer, `animal ${id} is passive`);
    }
    for (const id of [2, 3, 4, 9]) { // bull, bully, wolf, boar
        const a = byId(id);
        assert.ok(a.hostile && a.chargePlayer && a.viewRange > 0 && a.dmg > 0, `${a.name} is a real hostile`);
    }
    for (const id of [6, 8, 11]) { // MOOSTAFA, MOOFIE, Crab King
        const a = byId(id);
        assert.ok(a.noTrap, `${a.name} cannot be trapped`);
        assert.ok(a.dontRun, `${a.name} never flees`);
    }
    const crabKing = byId(11);
    assert.equal(crabKing.boss, true, "Crab King is a boss");
    assert.ok(crabKing.health >= 100000, "Crab King raid-tier health");
    assert.ok(crabKing.hitRange > 0, "Crab King breaks structures (hitRange)");
});

test("spawn plan: boss arenas sit in the right biomes", () => {
    const mid = config.mapScale / 2;
    const moostafa = config.server.animalSpawnPlan.find(p => p.index === 6);
    assert.ok(moostafa.positions[0].yRatio * config.mapScale >= config.mapScale - config.snowBiomeTop, "MOOSTAFA arena is in the desert");

    const moofie = config.server.animalSpawnPlan.find(p => p.index === 8);
    assert.ok(moofie.positions[0].yRatio * config.mapScale <= config.snowBiomeTop, "MOOFIE arena is in the snow");

    const crab = config.server.animalSpawnPlan.find(p => p.index === 11);
    assert.equal(crab.area, "secret");
    assert.ok(crab.positions[0].x < 0 && Math.abs(crab.positions[0].y - mid) < 1000, "Crab King lives in the secret pool");
});
