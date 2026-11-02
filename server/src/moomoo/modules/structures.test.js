// STRUCTURES / BUILDING
// Acceptance coverage (briefing §6.3, §11 items 5-7):
//   - building charges the recipe exactly once and validates resources, group limit,
//     overlap, river and blocker radius;
//   - spikes are solid, deal damage and knockback, respect owner/team;
//   - pit trap immobilizes without being a spike; boost pad pushes; healing pad heals;
//   - teleporter relocates; spawn pad becomes the respawn point and is consumed;
//   - windmill pays pps; turret shoots only valid targets at its authoritative cadence.

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, placeObject, withRandom,
    itemByName, config
} from "../../testing/harness.test.js";

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    return game;
}

function activeObjects(game) {
    return game.game_objects.filter(o => o.active);
}

test("building charges the recipe once and rejects a second overlapping placement", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 5000, 3000, 0);
    const wall = itemByName("wood wall"); // req: wood 10
    player.wood = 25;

    player.buildItem(wall);
    assert.equal(player.wood, 15, "charged exactly wood 10");
    assert.equal(activeObjects(game).length, 1, "wall placed");
    assert.equal(player.itemCounts[wall.group.id], 1, "group counter incremented");
    assert.equal(player.buildIndex, -1, "build mode closes after the placement");

    player.buildItem(wall); // same click sequence again: same spot -> overlap
    assert.equal(player.wood, 15, "no second charge for an invalid overlapping placement");
    assert.equal(activeObjects(game).length, 1, "still only one wall");
});

test("building validates resources and group limit", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 5000, 3000, 0);
    const wall = itemByName("wood wall");

    player.wood = 5; // below the 10 wood recipe
    player.buildItem(wall);
    assert.equal(activeObjects(game).length, 0, "insufficient resources place nothing");
    assert.equal(player.wood, 5, "no partial charge");

    player.wood = 1000;
    player.itemCounts[wall.group.id] = wall.group.limit; // walls: 30
    assert.equal(player.canBuild(wall), false, "group limit blocks building");
    player.buildItem(wall);
    assert.equal(activeObjects(game).length, 0, "nothing placed past the group limit");
    assert.equal(player.wood, 1000, "no charge when the group is full");
});

test("river rejects normal construction but accepts the platform", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    const riverY = config.mapScale / 2; // inside the river band
    place(player, 5000, riverY - 80, Math.PI / 2); // placement lands at y = riverY

    const wall = itemByName("wood wall");
    player.buildItem(wall);
    assert.equal(activeObjects(game).length, 0, "wall cannot be placed in the river");

    const platform = itemByName("platform");
    const woodBefore = player.wood;
    player.buildItem(platform);
    assert.equal(activeObjects(game).length, 1, "platform is the river exception");
    assert.equal(player.wood, woodBefore - 20, "platform charged its recipe");
});

test("blocker denies building inside its radius and allows it outside", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const blocker = placeObject(game, itemByName("blocker"), 5000, 5000, 0, owner);

    const player = addPlayer(game);
    place(player, 5120, 5000, 0); // wall would land at (5200, 5000), 200 < 50 + 300
    const wall = itemByName("wood wall");
    player.buildItem(wall);
    assert.equal(activeObjects(game).length, 1, "wall inside the blocker radius refused");

    place(player, 5520, 5000, 0); // wall lands at (5600, 5000), 600 > 350
    player.buildItem(wall);
    assert.equal(activeObjects(game).length, 2, "wall outside the radius is fine");
    assert.ok(blocker.active);
});

test("spikes are solid and deal damage + knockback to enemies, never to owner/team", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const spike = placeObject(game, itemByName("spikes"), 6000, 3000, 0, owner); // dmg 20, scale 49

    const enemy = addPlayer(game, { name: "enemy" });
    place(enemy, 6040, 3000); // overlapping: 40 < 35 + 49
    game.object_manager.checkCollision(enemy, spike, 1);
    assert.equal(enemy.health, 100 - 20, "spike contact deals its table damage");
    assert.equal(enemy.x, 6000 + 35 + 49, "solid spike pushes the enemy out to its radius");
    assert.ok(enemy.xVel > 1.4, `knockback pushes away from the spike (xVel ${enemy.xVel.toFixed(2)})`);

    place(owner, 6040, 3000);
    game.object_manager.checkCollision(owner, spike, 1);
    assert.equal(owner.health, 100, "owner takes no damage from own spikes");
    assert.equal(owner.x, 6084, "spikes are still solid for the owner");

    owner.team = "CLAN";
    const mate = addPlayer(game, { name: "mate" });
    mate.team = "CLAN";
    place(mate, 6040, 3000);
    game.object_manager.checkCollision(mate, spike, 1);
    assert.equal(mate.health, 100, "teammates take no spike damage");
});

test("poison spikes apply damage over time; Anti Venom blocks it", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const spike = placeObject(game, itemByName("poison spikes"), 6000, 3000, 0, owner);

    const enemy = addPlayer(game, { name: "enemy" });
    place(enemy, 6040, 3000);
    game.object_manager.checkCollision(enemy, spike, 1);
    assert.equal(enemy.health, 100 - 30, "poison spikes deal their table damage");
    assert.equal(enemy.dmgOverTime.dmg, 5, "poison applied (5/tick)");
    assert.equal(enemy.dmgOverTime.time, 5, "poison lasts 5 ticks");
    place(enemy, 9000, 9000); // walk away from the spike
    enemy.update(1000); // one regen/poison tick
    assert.equal(enemy.health, 70 - 5, "poison tick measured");

    const immune = addPlayer(game, { name: "immune" });
    immune.skin = { poisonRes: 1 };
    place(immune, 6040, 3000);
    game.object_manager.checkCollision(immune, spike, 1);
    assert.equal(immune.dmgOverTime.dmg, undefined, "poisonRes blocks the poison");
});

test("pit trap immobilizes enemies without damaging them; owner walks free", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const trap = placeObject(game, itemByName("pit trap"), 6000, 3000, 0, owner);

    const enemy = addPlayer(game, { name: "enemy" });
    place(enemy, 6000, 3000);
    enemy.update(16); // arms lockMove through the real collision pass
    assert.equal(enemy.lockMove, true, "trap locks movement");
    assert.equal(enemy.health, 100, "pit trap is not a spike: no damage");
    assert.equal(trap.hideFromEnemy, false, "sprung trap becomes visible to enemies");

    enemy.moveDir = 0; // try to walk east
    enemy.update(100);
    assert.equal(enemy.x, 6000, "trapped player cannot move");
    assert.equal(enemy.y, 3000);

    place(owner, 6000, 3000);
    owner.update(16);
    assert.equal(owner.lockMove, false, "owner is never trapped by own pit");
});

test("boost pad impels along its facing direction", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const dir = Math.PI / 2;
    const pad = placeObject(game, itemByName("boost pad"), 7000, 3000, dir, owner); // boostSpeed 1.5

    const player = addPlayer(game);
    place(player, 7000, 3000);
    game.object_manager.checkCollision(player, pad, 1);
    assert.ok(Math.abs(player.xVel - 1.5 * Math.cos(dir)) < 1e-9, "boost xVel follows pad dir");
    assert.ok(Math.abs(player.yVel - 1.5 * Math.sin(dir)) < 1e-9, "boost yVel follows pad dir");

    const y0 = player.y;
    player.update(16);
    assert.ok(player.y > y0, "boost displaces the player along the pad direction");
});

test("healing pad restores 15 health per second while standing on it", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    placeObject(game, itemByName("healing pad"), 7500, 3000, 0, owner); // healCol 15

    const player = addPlayer(game);
    player.health = 50;
    place(player, 7500, 3000);
    player.update(16);   // collision pass picks up healCol
    player.update(1000); // one regen tick consumes it
    assert.equal(player.health, 65, "healed exactly 15 in one second");
});

test("teleporter relocates the player to a random map point", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const tele = placeObject(game, itemByName("teleporter"), 8000, 3000, 0, owner);

    const player = addPlayer(game);
    place(player, 8000, 3000);
    withRandom(0.5, () => game.object_manager.checkCollision(player, tele, 1));
    assert.equal(player.x, config.mapScale / 2, "teleported to the rolled x");
    assert.equal(player.y, config.mapScale / 2, "teleported to the rolled y");
});

test("spawn pad becomes the respawn point and is consumed on use", (t) => {
    const game = setup(t);
    const player = addPlayer(game); // moofoll: 100 wood / 100 stone, exactly the recipe
    place(player, 3000, 3000, 0);
    const pad = itemByName("spawn pad");

    player.buildItem(pad);
    assert.equal(player.wood, 0, "spawn pad charged wood 100");
    assert.equal(player.stone, 0, "spawn pad charged stone 100");
    assert.equal(player.itemCounts[pad.group.id], 1);
    const padObj = activeObjects(game)[0];
    assert.ok(padObj.spawnPoint, "object carries the spawn point flag");

    player.spawn(true); // die + respawn cycle uses fetchSpawnObj
    assert.equal(player.x, padObj.x, "respawned on the pad");
    assert.equal(player.y, padObj.y);
    assert.equal(padObj.active, false, "pad is consumed by the respawn");
    assert.equal(player.itemCounts[pad.group.id], 0, "group counter released");
});

test("windmill pays its pps once per second and stops when destroyed", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 4000, 3000, 0);
    const mill = itemByName("windmill"); // pps 1

    player.buildItem(mill);
    assert.equal(player.pps, 1, "pps armed on placement");
    const points0 = player.points;
    player.update(1000);
    assert.equal(player.points, points0 + 1, "one second pays exactly pps 1");

    const millObj = activeObjects(game)[0];
    game.object_manager.disableObj(millObj);
    assert.equal(player.pps, 0, "destroying the mill stops the payout");
    player.update(1000);
    assert.equal(player.points, points0 + 1, "no payout after destruction");
});

test("turret shoots valid targets at its cadence and skips owner/team/EMP/invisible", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const turret = placeObject(game, itemByName("turret"), 5000, 5000, 0, owner); // range 700, rate 2200

    const enemy = addPlayer(game, { name: "enemy" });
    place(enemy, 5500, 5000); // 500 < 700

    game.updateStructures(2201); // shootCount (2200) elapses
    const shots = () => game.projectiles.filter(p => p.active && p.owner === owner).length;
    assert.equal(shots(), 1, "turret fired at the enemy in range");
    assert.ok(Math.abs(turret.dir) < 0.01, "turret aimed at the target (east)");

    // cadence: half a cycle later no second shot
    game.updateStructures(300);
    assert.equal(shots(), 1, "no second shot before shootRate elapses");

    turret.shootCount = 0;
    place(enemy, 9000, 9000); // out of range
    game.updateStructures(16);
    assert.equal(shots(), 1, "no target in range -> no shot");
    assert.equal(turret.shootCount, 250, "idle re-check interval is 250 ms");

    turret.shootCount = 0;
    place(enemy, 5500, 5000);
    enemy.skin = { antiTurret: 1 }; // Emp Helmet
    game.updateStructures(16);
    assert.equal(shots(), 1, "EMP Helmet wearer is ignored");

    enemy.skin = null;
    enemy.team = owner.team = "CLAN";
    turret.shootCount = 0;
    game.updateStructures(16);
    assert.equal(shots(), 1, "teammates are ignored");

    enemy.team = null;
    enemy.powers.invisible = 1;
    turret.shootCount = 0;
    game.updateStructures(16);
    assert.equal(shots(), 1, "invisible players are ignored");
});
