// WORLD / BIOMES / BOUNDS
// Acceptance coverage (briefing §6.6, §11 item 13):
//   - river: 0.33 speed + downstream current; watrImm softens both; platform crosses over;
//   - snow: 0.75 speed, Winter Cape / coldM hats immune, Snowball halves it;
//   - desert: bushes become cacti (20 contact damage) below the desert line only;
//   - map bounds clamp; the secret area west of x=0 is reachable through the gorge only.
//
// Note on fixtures: the reference decel zeroes velocities below 0.01, so biome ratios are
// measured at terminal velocity (primed above equilibrium, 960 ms burn-in, then measured).

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, placeObject, step,
    itemByName, hatById, accessoryById, config
} from "../../testing/harness.test.js";
import { secretDistance, inSecretPool } from "./effects.js";

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    return game;
}

// Southward displacement over 960 ms measured at terminal velocity.
function southDisplacement(game, x, y, { skin = null, tail = null } = {}) {
    const player = addPlayer(game, { name: "probe" + Math.random() });
    place(player, x, y);
    player.skin = skin;
    player.tail = tail;
    player.moveDir = Math.PI / 2;
    player.yVel = 0.5;      // above every biome equilibrium: decays to terminal velocity
    step(player, 960);      // burn-in
    const y0 = player.y;
    step(player, 960);      // measured window
    return player.y - y0;
}

// Eastward downstream drift with no input, measured at terminal velocity.
function driftDisplacement(game, skin = null) {
    const p = addPlayer(game, { name: "drift" + Math.random() });
    place(p, 5000, config.mapScale / 2);
    p.skin = skin;
    p.xVel = 0.5;           // primed (the watrImm current alone is below the decel epsilon)
    step(p, 960);           // burn-in
    const x0 = p.x;
    step(p, 960);
    return p.x - x0;
}

test("river: water slows to 0.33 and drifts downstream; watrImm softens both", (t) => {
    const game = setup(t);

    const land = southDisplacement(game, 5000, 3000);
    const river = southDisplacement(game, 5000, 7000); // inside the 7200 +/- 362 band
    assert.ok(Math.abs(river / land - 0.33) < 0.01, `river speed factor 0.33 (got ${(river / land).toFixed(3)})`);

    const swimmer = southDisplacement(game, 5000, 7000, { skin: { watrImm: 1 } });
    assert.ok(Math.abs(swimmer / land - 0.75) < 0.01, `watrImm keeps 0.75 speed (got ${(swimmer / land).toFixed(3)})`);

    const full = driftDisplacement(game, null);
    assert.ok(full > 10, `current pushes downstream without input (+${full.toFixed(1)})`);
    const ratio = driftDisplacement(game, { watrImm: 1 }) / full;
    assert.ok(Math.abs(ratio - 0.4) < 0.02, `watrImm current is 0.4x (got ${ratio.toFixed(3)})`);
});

test("platform over the river removes the water penalty (zIndex)", (t) => {
    const game = setup(t);
    const riverY = config.mapScale / 2;
    const owner = addPlayer(game, { name: "owner" });
    placeObject(game, itemByName("platform"), 5000, riverY, 0, owner);

    const player = addPlayer(game, { name: "walker" });
    place(player, 5000, riverY);
    player.update(16); // collision pass lifts the player onto the platform
    assert.equal(player.zIndex, 1, "standing on the platform");

    player.xVel = 0; // isolate the next tick: no current should be added
    player.update(16);
    assert.equal(player.xVel, 0, "no river current while on the platform");

    // single-tick southward impulse equals dry land exactly (zIndex stays armed between ticks)
    player.xVel = player.yVel = 0;
    player.moveDir = Math.PI / 2;
    player.update(16);
    const onPad = player.yVel;

    const lander = addPlayer(game, { name: "lander" });
    place(lander, 5000, 3000);
    lander.moveDir = Math.PI / 2;
    lander.update(16);
    assert.ok(onPad > 0 && Math.abs(onPad - lander.yVel) < 1e-12, "full speed impulse on the platform over the river");
});

test("snow biome slows to 0.75; Winter Cape/coldM immune; Snowball halves", (t) => {
    const game = setup(t);
    const snowY = 1200; // deep inside the snow (y <= 2400) so the whole path stays in it

    const land = southDisplacement(game, 5000, 3000);
    const snow = southDisplacement(game, 5000, snowY);
    assert.ok(Math.abs(snow / land - config.snowSpeed) < 0.01, `snow speed 0.75 (got ${(snow / land).toFixed(3)})`);

    const caped = southDisplacement(game, 5000, snowY, { tail: accessoryById(6) }); // Winter Cape
    assert.ok(Math.abs(caped / land - 1) < 0.01, "Winter Cape: no slowdown");

    const capped = southDisplacement(game, 5000, snowY, { skin: hatById(15) }); // Winter Cap (coldM)
    assert.ok(Math.abs(capped / land - 1) < 0.01, "coldM hat: no slowdown");

    const balled = southDisplacement(game, 5000, snowY, { tail: accessoryById(12) }); // Snowball
    assert.ok(Math.abs(balled / land - (1 - (1 - config.snowSpeed) * 0.5)) < 0.01,
        `Snowball: half slowdown (got ${(balled / land).toFixed(3)})`);
});

test("desert: bushes become damaging cacti below the desert line only", (t) => {
    const game = setup(t);
    const desertY = config.mapScale - 1000; // below mapScale - snowBiomeTop
    game.object_manager.add(game.game_objects.length, 5000, desertY, 0, 80, 1, undefined, false, null);
    const cactus = game.game_objects.find(o => o.active && o.x === 5000 && o.y === desertY);
    assert.equal(cactus.name, "cactus", "bush converted to cactus in the desert");
    assert.equal(cactus.dmg, 20, "reference cactus damage");

    const victim = addPlayer(game, { name: "victim" });
    place(victim, 5030, desertY);
    game.object_manager.checkCollision(victim, cactus, 1);
    assert.equal(victim.health, 80, "cactus contact deals 20");
    assert.ok(victim.xVel > 0, "cactus knocks back");

    const bushY = 5000;
    game.object_manager.add(game.game_objects.length, 5000, bushY, 0, 80, 1, undefined, false, null);
    const bush = game.game_objects.find(o => o.active && o.x === 5000 && o.y === bushY);
    assert.notEqual(bush.name, "cactus", "no cactus conversion outside the desert");
    assert.equal(bush.dmg, undefined, "regular bush has no contact damage");
});

test("map bounds clamp players and animals inside the map", (t) => {
    const game = setup(t);
    const player = addPlayer(game);

    // west wall: a player crossing FROM inside the map is clamped to playerScale
    place(player, 20, 4000); // stay outside the secret gorge regardless of the random spawn
    player.keepInWorld(100, 4000);
    assert.equal(player.x, config.playerScale, "west wall clamps to playerScale");

    // east/north/south walls are unconditional clamps
    player.x = config.mapScale - 10;
    player.keepInWorld(player.x, 4000);
    assert.equal(player.x, config.mapScale - config.playerScale, "east wall");
    player.y = 10;
    player.keepInWorld(5000, 10);
    assert.equal(player.y, config.playerScale, "north wall");
    player.y = config.mapScale - 10;
    player.keepInWorld(5000, player.y);
    assert.equal(player.y, config.mapScale - config.playerScale, "south wall");

    const cow = game.ai_manager.spawn(20, 3000, 0, 0);
    cow.update(16);
    assert.ok(cow.x >= cow.scale, "animals clamp to the map as well");
});

test("secret area: west wall is only passable through the gorge/pool", (t) => {
    const game = setup(t);
    const mid = config.mapScale / 2;

    // geometry helpers (the same ones the movement code uses)
    assert.ok(secretDistance(config, -50, 3000) > 0, "off-gorge west side is outside");
    assert.ok(secretDistance(config, -50, mid) <= 0, "gorge is inside the walkable pocket");
    assert.ok(inSecretPool(config, -2500, mid), "pool centre is deep water");

    // blocked crossing off-gorge: position is rolled back and velocity zeroed
    const player = addPlayer(game);
    place(player, -50, 3000);
    player.xVel = -1;
    player.keepInWorld(-50, 3000);
    assert.equal(player.x, -50, "no westward progress off-gorge");
    assert.equal(player.xVel, 0, "westward velocity cancelled");

    // gorge crossing at river height is allowed
    const gorge = addPlayer(game, { name: "gorge" });
    place(gorge, -50, mid);
    gorge.xVel = -1;
    gorge.keepInWorld(-50, mid);
    assert.equal(gorge.xVel, -1, "gorge passage keeps the velocity");

    // the secret pool is deep water: 0.33 speed, no current
    const swimmer = addPlayer(game, { name: "swimmer" });
    place(swimmer, -2500, mid);
    swimmer.update(16);
    assert.equal(swimmer.xVel, 0, "no current in the pool");

    const land = southDisplacement(game, 5000, 3000);
    const pool = southDisplacement(game, -2500, mid);
    assert.ok(Math.abs(pool / land - 0.33) < 0.01, `pool slows like deep water (got ${(pool / land).toFixed(3)})`);
});
