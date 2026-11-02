// STORE EFFECTS (hats & accessories measured through the real Player code paths)
// Acceptance coverage (briefing §6.5, §11 items 12, 14): every equipped effect below is
// measured as a behaviour change, not just ownership.

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, step,
    hatById, accessoryById
} from "../../testing/harness.test.js";

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    return game;
}

function duel(game) {
    const attacker = addPlayer(game, { name: "attacker" });
    const target = addPlayer(game, { name: "target" });
    place(attacker, 5000, 3000, 0);
    place(target, 5100, 3000);
    return { attacker, target };
}

test("healthRegen hats heal over time; Bull Helmet drains health and adds damage", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 5000, 3000);

    player.skin = hatById(13); // Medic Gear: healthRegen 3
    player.health = 50;
    player.update(1000);
    assert.equal(player.health, 53, "Medic Gear heals 3/s");

    player.skin = hatById(7); // Bull Helmet: healthRegen -5, dmgMultO 1.5
    player.health = 50;
    player.update(1000);
    assert.equal(player.health, 45, "Bull Helmet drains 5/s");

    const { attacker, target } = duel(game);
    attacker.skin = hatById(7);
    attacker.gather();
    assert.equal(target.health, 100 - 25 * 1.5, "Bull Helmet damage bonus measured");
});

test("gather bonuses: Tree/Stone/Cookie Cape, Miners Helmet extra gold", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 5000, 3000, 0);

    // natural objects (no health): tree (type 0), rock (type 2), bush (type 1)
    const mk = (x, type) => {
        game.object_manager.add(game.game_objects.length, x, 3000, 0, 80, type, undefined, false, null);
        return game.game_objects.find(o => o.active && o.x === x && o.y === 3000);
    };
    const wood0 = player.wood;
    mk(5060, 0);
    player.gather();
    assert.equal(player.wood - wood0, 1, "tree gives 1 wood per hammer hit");

    player.tail = accessoryById(9); // Tree Cape
    player.gather();
    assert.equal(player.wood - wood0, 1 + 2, "Tree Cape adds +1 wood per hit");

    player.tail = accessoryById(10); // Stone Cape
    const stone0 = player.stone;
    place(player, 5000, 3000, 0);
    mk(5060, 2);
    player.gather();
    assert.equal(player.stone - stone0, 2, "Stone Cape adds +1 stone per hit");

    player.tail = accessoryById(3); // Cookie Cape
    const food0 = player.food;
    mk(5060, 1);
    player.gather();
    assert.equal(player.food - food0, 2, "Cookie Cape adds +1 food per bush hit");

    player.tail = null;
    player.skin = hatById(9); // Miners Helmet: extraGold 1
    const gold0 = player.points;
    mk(5060, 0);
    place(player, 5000, 3000, 0);
    player.gather();
    assert.ok(player.points - gold0 >= 1, "Miners Helmet adds gold on natural hits");
});

test("Windmill Hat pays its pps per second", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    place(player, 5000, 3000);
    player.skin = hatById(14); // Windmill Hat: pps 1.5
    const gold0 = player.points;
    player.update(1000);
    assert.equal(player.points - gold0, 1.5, "Windmill Hat pays 1.5 gold/s");
});

test("reflect: Spike Gear and Crab Shell hurt the attacker back", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);

    target.skin = hatById(11); // Spike Gear: dmg 0.45
    attacker.gather();
    assert.equal(target.health, 75, "target takes the hit");
    assert.equal(attacker.health, 100 - 25 * 0.45, "Spike Gear reflects 45% of base damage");

    attacker.health = 100;
    target.health = 100;
    target.skin = hatById(61); // Crab Shell: dmgMult 0.8, dmg 0.375
    attacker.gather();
    assert.equal(target.health, 100 - 25 * 0.8, "Crab Shell reduces incoming damage");
    assert.equal(attacker.health, 100 - 25 * 0.375, "Crab Shell reflects 37.5%");
});

test("healD hats: Dark Knight and Bloodthirster heal part of the damage dealt", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);

    attacker.skin = hatById(58); // Dark Knight: healD 0.4
    attacker.health = 50;
    attacker.gather();
    assert.equal(attacker.health, 50 + 25 * 0.4, "Dark Knight heals 40% of damage");

    attacker.skin = hatById(55); // Bloodthirster: healD 0.25, dmgMultO 1.2
    attacker.health = 50;
    target.health = 100;
    attacker.gather();
    assert.equal(target.health, 100 - 25 * 1.2, "Bloodthirster damage bonus measured");
    assert.equal(attacker.health, 50 + 25 * 1.2 * 0.25, "Bloodthirster heals 25% of damage dealt");
});

test("Devils Tail bleeds, Thorns heal on hit, Plague Mask poisons", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);

    attacker.tail = accessoryById(20); // Devils Tail
    attacker.gather();
    assert.equal(target.dmgOverTime.dmg, 4, "bleed of 4 per tick");
    assert.equal(target.dmgOverTime.time, 2, "bleeds for 2 ticks");

    const g2 = setup(t);
    const d2 = duel(g2);
    d2.attacker.tail = accessoryById(14); // Thorns
    d2.attacker.health = 50;
    d2.attacker.gather();
    assert.equal(d2.attacker.health, 50 + 25 * 0.05, "Thorns heals 5% of damage dealt");

    const g3 = setup(t);
    const d3 = duel(g3);
    d3.attacker.skin = hatById(21); // Plague Mask: poisonDmg
    d3.attacker.gather();
    assert.equal(d3.target.dmgOverTime.dmg, 5, "Plague Mask poisons on hit");
    assert.ok(d3.target.dmgOverTime.time >= 1, "poison has a duration");
});

test("Assassin Gear: cannot eat and turns invisible after standing still", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    player.skin = hatById(56); // Assassin Gear: noEat, invisTimer 1000

    player.health = 50;
    player.food = 100;
    player.hitTime = 0;
    const apple = items.list.find(i => i.name === "apple");
    player.buildItem(apple);
    assert.equal(player.health, 50, "noEat blocks food items");
    assert.equal(player.food, 100, "no food charged");

    const viewer = addPlayer(game, { name: "viewer" });
    place(viewer, 5000, 3000);
    place(player, 5100, 3000);
    player.update(1000); // noMovTimer accumulates past invisTimer
    assert.equal(viewer.canSee(player), false, "invisible after 1s still");
    player.xVel = 0.5;
    player.update(16);
    assert.equal(viewer.canSee(player), true, "visible again after moving");
});

import { items } from "../../testing/harness.test.js";
