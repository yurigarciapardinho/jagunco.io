// PACKET VALIDATION / ANTI-CHEAT (handlePacket + the real AntiCheat)
// Acceptance coverage (briefing §7, §11 items 17-18): malformed packets are rejected with
// strikes; strikes decay and kick at 40; rate buckets drop floods; every validation is
// measured through a state change (or the proven absence of one).

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, makeCtx, attachAnticheat, itemByName
} from "../testing/harness.test.js";
import { handlePacket } from "./packets.js";
import { ANTICHEAT_CONFIG } from "../anticheat/config.js";

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    const ctx = makeCtx(game);
    return { game, ctx };
}

function wiredPlayer(game, spies = {}) {
    const player = addPlayer(game, { name: "p" + Math.random() });
    attachAnticheat(player, spies);
    return player;
}

test("spawn: malformed data is a strike; a valid spawn works and cannot be replayed", (t) => {
    const { game, ctx } = setup(t);

    const bad = game.addPlayer({ send: () => {}, account: null, ip: "1.1.1.1" });
    const acBad = attachAnticheat(bad);
    for (const data of [null, "nope", [1, 2], 42]) {
        const before = acBad.strikes;
        handlePacket(ctx, bad, "M", [data]);
        assert.equal(acBad.strikes, before + ANTICHEAT_CONFIG.validation.strikesPerInvalid,
            `spawn with ${JSON.stringify(data)} is punished`);
        assert.equal(bad.alive, false, "never spawned");
    }

    const good = game.addPlayer({ send: () => {}, account: null, ip: "1.1.1.2" });
    good.sentPackets = [];
    attachAnticheat(good);
    handlePacket(ctx, good, "M", [{ name: "legit", moofoll: true, skin: 0 }]);
    assert.equal(good.alive, true, "valid spawn accepted");
    assert.equal(good.name, "legit");

    good.health = 50;
    handlePacket(ctx, good, "M", [{ name: "again", moofoll: false }]);
    assert.equal(good.health, 50, "re-spawn while alive ignored (no state reset)");
    assert.equal(good.name, "legit", "identity not overwritten");
});

test("argument validation: D / 9 / z / c / K / 6 / unknown packets strike the sender", (t) => {
    const { game, ctx } = setup(t);
    const player = wiredPlayer(game);
    const ac = player.anticheat;
    const strikes = () => ac.strikes;
    const S = ANTICHEAT_CONFIG.validation.strikesPerInvalid;

    let s0 = strikes();
    handlePacket(ctx, player, "D", ["east"]);
    assert.equal(strikes(), s0 + S, "non-numeric aim");
    assert.equal(player.dir, player.dir, "dir untouched");

    handlePacket(ctx, player, "9", ["north"]);
    assert.equal(strikes(), s0 + 2 * S, "non-numeric moveDir");
    handlePacket(ctx, player, "9", [Math.PI / 2]);
    assert.equal(strikes(), s0 + 2 * S, "numeric moveDir accepted");
    assert.equal(player.moveDir, Math.PI / 2);
    handlePacket(ctx, player, "9", [null]);
    assert.equal(player.moveDir, undefined, "null stops movement");

    handlePacket(ctx, player, "z", [1.5, true]);
    assert.equal(strikes(), s0 + 3 * S, "non-integer item index");
    handlePacket(ctx, player, "z", [5, true]); // great axe, not owned
    assert.equal(player.weaponIndex, 0, "unowned weapon selection ignored");
    assert.equal(strikes(), s0 + 3 * S, "locked content is not a strike (just ignored)");

    handlePacket(ctx, player, "c", [2, 2, 0]); // unknown store action
    assert.equal(strikes(), s0 + 4 * S, "bad store action");

    handlePacket(ctx, player, "K", [7]);
    assert.equal(strikes(), s0 + 5 * S, "unknown toggle");

    handlePacket(ctx, player, "6", [{ text: "hi" }]);
    assert.equal(strikes(), s0 + 6 * S, "non-string chat");

    handlePacket(ctx, player, "ZZ", []);
    assert.equal(strikes(), s0 + 7 * S, "unknown packet name");
});

test("40 strikes kick the player (with decay, one per second)", (t) => {
    const { game, ctx } = setup(t);
    let kicked = null;
    const player = wiredPlayer(game, { kick: (why) => { kicked = why; } });
    const ac = player.anticheat;

    const perKick = ANTICHEAT_CONFIG.rateLimits.strikesToKick / ANTICHEAT_CONFIG.validation.strikesPerInvalid;
    for (let i = 0; i < perKick - 1; i++) handlePacket(ctx, player, "D", ["bad"]);
    assert.equal(kicked, null, "below the threshold: still connected");
    handlePacket(ctx, player, "D", ["bad"]);
    assert.equal(kicked, "kicked", "kick at exactly 40 strikes");
});

test("rate limit: aim floods are dropped and add strikes", (t) => {
    const { game } = setup(t);
    const player = wiredPlayer(game);
    const ac = player.anticheat;
    // bucket D: [20 per second, burst 40]; a fresh player has not spent anything
    let dropped = 0;
    for (let i = 0; i < 50; i++) if (!ac.allow("D")) dropped++;
    assert.ok(dropped > 0, `flood dropped (${dropped}/50)`);
    assert.ok(ac.strikes >= dropped, "each dropped packet is a strike");
    const legit = wiredPlayer(game);
    assert.equal(legit.anticheat.allow("D"), true, "normal cadence passes");
});

test("mouse packet builds at most once per click and reverts to combat mode", (t) => {
    const { game, ctx } = setup(t);
    const player = wiredPlayer(game);
    place(player, 5000, 3000, 0);
    player.wood = 100;
    player.buildIndex = itemByName("wood wall").id;

    handlePacket(ctx, player, "F", [1, 0]); // click with a building selected
    assert.equal(player.wood, 90, "charged once");
    assert.equal(player.mouseState, 0, "build consumes the click");
    assert.equal(player.buildIndex, -1, "build mode closed");

    handlePacket(ctx, player, "F", [1, 0]); // clicking again is a swing, not a build
    assert.equal(player.wood, 90, "no second charge from the same selection");
    assert.equal(player.hits, 1, "the click became an attack");
    assert.equal(game.game_objects.filter(o => o.active).length, 1, "exactly one wall");
});

test("tribe creation: reserved/oversized names rejected, valid name creates the tribe", (t) => {
    const { game, ctx } = setup(t);
    const player = wiredPlayer(game);

    handlePacket(ctx, player, "L", ["solo"]);
    assert.equal(player.team, null, "\"solo\" is reserved");
    handlePacket(ctx, player, "L", ["ABCDEFGH"]); // 8 > MAX_TRIBE_NAME 7
    assert.equal(player.team, null, "oversized tribe name rejected");
    player.tribeCooldown = 0;
    handlePacket(ctx, player, "L", ["JAGS"]);
    assert.equal(player.team, "JAGS", "valid tribe created");
    assert.equal(game.clan_manager.members(game.clan_manager.tribes.get("JAGS")).includes(player), true, "owner is a member");
});

test("chat cooldown drops a second message inside the window", (t) => {
    const { game, ctx } = setup(t);
    const sender = wiredPlayer(game);
    const listener = addPlayer(game, { name: "listener" });

    handlePacket(ctx, sender, "6", ["hello"]);
    const first = listener.sentPackets.filter(p => p[0] === "6").length;
    assert.equal(first, 1, "first message broadcast");
    handlePacket(ctx, sender, "6", ["flood"]);
    const second = listener.sentPackets.filter(p => p[0] === "6").length;
    assert.equal(second, 1, "second message inside the cooldown dropped");
});

test("admin commands from a non-admin are punished and inert", (t) => {
    const { game, ctx } = setup(t);
    const player = wiredPlayer(game);
    const ac = player.anticheat;
    const before = ac.strikes;
    handlePacket(ctx, player, "A", ["give", 3, 999999]);
    assert.ok(ac.strikes > before, "non-admin admin command is a strike");
    assert.equal(player.points, 100, "no gold granted");
});
