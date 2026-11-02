// AI / ANIMALS
// Acceptance coverage (briefing §6.4, §11 items 1-4, 15):
//   - a passive animal never starts fleeing just because a player is near;
//   - after damage it flees in the correct direction for the correct duration;
//   - hostile animals acquire targets by range, chase, attack and give up correctly;
//   - noTrap entities (incl. bosses) are never locked by pit traps; Yeti rules;
//   - kill rewards / drops / respawn follow the reference table.

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, placeObject, step, withRandom,
    dist, toward, velDot, itemByName, accessoryById
} from "../../testing/harness.test.js";
import { AI_TYPES } from "./aiManager.js";

const COW = 0, WOLF = 4, QUACK = 5, MOOSTAFA = 6, MOOFIE = 8, YETI = 10;

function spawnAnimal(game, index, x, y, dir = 0) {
    return game.ai_manager.spawn(x, y, dir, index);
}

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    return game;
}

test("passive animal does not flee from mere proximity", (t) => {
    const game = setup(t);
    const cow = spawnAnimal(game, COW, 2000, 3000);
    const player = addPlayer(game);
    place(player, cow.x + cow.scale + 10, cow.y); // standing right next to it

    for (let i = 0; i < 200; i++) {
        cow.update(16);
        assert.equal(cow.runFrom, null, "cow must not enter flee state without being hit");
        assert.equal(cow.chargeTarget, null, "passive cow must never acquire a target");
    }
});

test("passive animal hit by a player flees away from the hitter for ~2s", (t) => {
    const game = setup(t);
    // The cow starts facing away from the player: this isolates the flee itself from the
    // reference turn arc (turnSpeed), which first rotates the animal toward targetDir.
    const cow = spawnAnimal(game, COW, 2000, 3000, Math.PI);
    const player = addPlayer(game);
    place(player, cow.x + 200, cow.y);

    cow.changeHealth(-25, player, player);
    assert.equal(cow.health, cow.maxHealth - 25, "the hit landed");
    assert.equal(cow.runFrom, player, "flee state is anchored to the attacker");
    assert.equal(cow.moveCount, 2000, "flee duration is the reference 2000 ms");
    assert.equal(cow.waitCount, 0, "flee starts immediately");

    // Direction: the cow must move AWAY from the player (distance grows while fleeing).
    const d0 = dist(cow, player);
    step(cow, 500);
    const d1 = dist(cow, player);
    assert.ok(d1 > d0 + 10, `cow moved away from the attacker (${d0.toFixed(1)} -> ${d1.toFixed(1)})`);
    const away = toward(player, cow);
    assert.ok(velDot(cow, away) >= 0, "cow velocity points away from the attacker");

    // Duration: after the 2 s flee window the cow calms down (runFrom cleared).
    step(cow, 1700);
    assert.equal(cow.runFrom, null, "flee ends when the 2000 ms flee counter expires");
    assert.ok(cow.waitCount > 0, "cow goes back to the wait/wander cycle");
    assert.equal(cow.health, cow.maxHealth - 25, "fleeing did not change health");
});

test("hostile wolf acquires the nearest player inside viewRange, chases and hits", (t) => {
    const game = setup(t);
    const wolf = spawnAnimal(game, WOLF, 4000, 3000);
    const player = addPlayer(game);
    place(player, 4300, 3000); // 300 < viewRange 800

    wolf.waitCount = 1; // next behaviour tick picks a target
    wolf.update(16);
    assert.equal(wolf.chargeTarget, player, "wolf locked the player in view range");

    // Chase: distance must shrink while charging (1.75x charge speed).
    const d0 = dist(wolf, player);
    step(wolf, 400);
    const d1 = dist(wolf, player);
    assert.ok(d1 < d0 - 20, `wolf closed in (${d0.toFixed(1)} -> ${d1.toFixed(1)})`);

    // Contact: reference contact damage (dmg 8, MAX_ATTACK roll is 0) + knockback away.
    let firstHit = null;
    for (let i = 0; i < 2000 && firstHit === null; i++) {
        wolf.update(16);
        if (player.health < 100) firstHit = 100 - player.health;
    }
    assert.equal(firstHit, AI_TYPES[WOLF].dmg, "contact hit deals exactly the table damage");
    const away = toward(wolf, player);
    assert.ok(velDot(player, away) > 0, "hit knocks the player away from the wolf");
});

test("hostile animal gives up when the target dies and respects wait cycle", (t) => {
    const game = setup(t);
    const wolf = spawnAnimal(game, WOLF, 4000, 3000);
    const player = addPlayer(game);
    place(player, 4300, 3000);

    wolf.waitCount = 1;
    wolf.update(16);
    assert.equal(wolf.chargeTarget, player);
    wolf.moveCount = 100; // shorten the chase window
    player.alive = false; // target died

    step(wolf, 200);
    assert.equal(wolf.chargeTarget, null, "dead target is dropped");
    assert.ok(wolf.waitCount > 1000 && wolf.waitCount <= 1500,
        `hostile animals re-arm the 1500 ms hostile wait (got ${wolf.waitCount})`);
});

test("Bull Mask (bullRepel) and invisibility prevent hostile targeting", (t) => {
    const game = setup(t);
    const wolf = spawnAnimal(game, WOLF, 4000, 3000);
    const player = addPlayer(game);
    place(player, 4100, 3000);

    player.skin = { bullRepel: 1 };
    wolf.waitCount = 1;
    wolf.update(16);
    assert.equal(wolf.chargeTarget, null, "bullRepel player is never chosen");

    player.skin = null;
    player.powers.invisible = 1;
    wolf.waitCount = 1;
    wolf.update(16);
    assert.equal(wolf.chargeTarget, null, "invisible player is never chosen");
});

test("hitScare: MOOFIE can be scared off (roll) but otherwise counter-charges", (t) => {
    const game = setup(t);
    const player = addPlayer(game);

    const scared = spawnAnimal(game, MOOFIE, 5000, 3000);
    place(player, 5200, 3000);
    withRandom(0, () => scared.changeHealth(-10, player, player)); // randInt(0,4) -> 0 -> scare
    assert.equal(scared.runFrom, player, "hitScare roll 0 makes even MOOFIE flee");
    assert.equal(scared.moveCount, 2000);

    const angry = spawnAnimal(game, MOOFIE, 5000, 3200);
    place(player, 5200, 3200);
    withRandom(0.999, () => angry.changeHealth(-10, player, player)); // no scare
    assert.equal(angry.runFrom, null, "no scare roll: does not flee");
    assert.equal(angry.chargeTarget, player, "hostile chargePlayer retaliates instead");
    assert.equal(angry.moveCount, 8000, "retaliation chase window is 8000 ms");
});

test("dontRun: MOOSTAFA never flees (even from a non-player attacker)", (t) => {
    const game = setup(t);
    const boss = spawnAnimal(game, MOOSTAFA, 6000, 3000);
    const turretLikeDoer = { isPlayer: false, active: true, x: 6100, y: 3000, canSee: () => false };
    boss.changeHealth(-50, turretLikeDoer, turretLikeDoer);
    assert.equal(boss.runFrom, null, "dontRun boss never flees");
    assert.equal(boss.chargeTarget, null, "non-player attacker is not charge-targeted");
});

test("noTrap: Quack walks over a pit trap; Yeti must also be untrappable (briefing rule)", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const trap = placeObject(game, itemByName("pit trap"), 7000, 3000, 0, owner);
    assert.ok(trap.active && trap.trap && trap.ignoreCollision, "fixture: pit trap placed");

    const quack = spawnAnimal(game, QUACK, 7000, 3000);
    game.object_manager.checkCollision(quack, trap, 1);
    assert.ok(!quack.lockMove, "noTrap Quack is not locked by the pit");

    const yeti = spawnAnimal(game, YETI, 7000, 3000);
    game.object_manager.checkCollision(yeti, trap, 1);
    assert.equal(Boolean(AI_TYPES[YETI].noTrap), true, "AI_TYPES[YETI] must declare noTrap (briefing: Yeti cannot be trapped)");
    assert.ok(!yeti.lockMove, "Yeti must not be locked by a pit trap");
});

test("Yeti breaks constructions blocking its charge (dmg*5 melee path, briefing rule)", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const wallObj = placeObject(game, itemByName("wood wall"), 8000, 3000, 0, owner);
    const yeti = spawnAnimal(game, YETI, 7600, 3000);
    const bait = addPlayer(game, { name: "bait" });
    place(bait, 7850, 3000); // in front of the wall: arms hitWait (dist <= hitRange + scale)
    yeti.waitCount = 1; // acquire the target on the first behaviour tick

    const healthBefore = wallObj.health;
    for (let i = 0; i < 400 && wallObj.active && wallObj.health === healthBefore; i++) yeti.update(16);
    assert.ok(wallObj.health < healthBefore || !wallObj.active,
        `Yeti must break the wall while charging (dmg*5 melee); health ${healthBefore} -> ${wallObj.health}`);
});

test("kill: reward score + drop table land on the killer and the animal respawns", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 2100, 3000);
    const cow = spawnAnimal(game, COW, 2000, 3000);
    const foodBefore = player.food;
    const pointsBefore = player.points;

    cow.changeHealth(-cow.maxHealth, player, player);
    assert.equal(player.points, pointsBefore + AI_TYPES[COW].killScore, "killScore paid once");
    assert.equal(player.food, foodBefore + 50, "cow drops 50 food per the table");
    assert.equal(cow.active, true, "normal animals stay active (respawn rules)");
    assert.equal(cow.health, cow.maxHealth, "respawned at full health");
});

test("Cow Cape pays 1.5x gold and food from cows (server hook)", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    player.tail = accessoryById(8); // Cow Cape
    const cow = spawnAnimal(game, COW, 2000, 3000);
    const foodBefore = player.food;
    const pointsBefore = player.points;

    cow.changeHealth(-cow.maxHealth, player, player);
    assert.equal(player.points, pointsBefore + Math.round(AI_TYPES[COW].killScore * 1.5), "1.5x kill score");
    assert.equal(player.food, foodBefore + Math.round(50 * 1.5), "1.5x food drop");
});

test("fixedSpawn + spawnDelay: MOOSTAFA leaves the map and respawns at its arena", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    const boss = spawnAnimal(game, MOOSTAFA, 7200, 13392); // desert arena (xRatio .5, yRatio .93)
    assert.equal(boss.startX, 7200, "fixedSpawn anchors the arena");

    boss.changeHealth(-boss.maxHealth, player, player);
    assert.equal(boss.spawnCounter, AI_TYPES[MOOSTAFA].spawnDelay, "respawn delay armed");
    assert.equal(boss.x, -1000000, "dead boss leaves the map while waiting");

    boss.spawnCounter = 10;
    boss.update(16);
    assert.equal(boss.x, 7200, "respawns at the fixed arena position");
    assert.equal(boss.y, 13392);
    assert.equal(boss.health, boss.maxHealth);
});
