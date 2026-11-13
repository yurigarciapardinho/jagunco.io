import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Game } from "../moomoo/server.js";
import { config } from "../moomoo/config.js";
import { ControlService } from "./service.js";
import { grantExperience, MAX_XP_GRANT, progression } from "./progression.js";

function fixture(t) {
  const packets = [];
  const game = new Game({ key: "XP", capacity: 40, worldMap: {
    version: 1, width: 14400, height: 14400, objects: [], encounters: [],
  } });
  game.stop();
  t.after(() => game.stop());
  const player = game.addPlayer({ send: (...args) => packets.push(args), ip: "127.0.0.1" });
  player.setUserData({ name: "ExperienceTest", skin: 0 });
  player.spawn(true);
  packets.length = 0;
  return { game, player, packets };
}

test("owner XP grants preserve overflow and native upgrade packets", t => {
  const { player, packets } = fixture(t);
  const resources = [player.wood, player.food, player.stone, player.points];
  grantExperience(player, 250);
  const result = grantExperience(player, 1000);
  assert.deepEqual(result.before, { age: 1, xp: 250, maxXp: 300, upgradePoints: 0 });
  assert.equal(player.age, 4);
  assert.ok(Math.abs(player.XP - 158) < 1e-8);
  assert.equal(player.upgradePoints, 3);
  assert.equal(result.granted, 1000);
  assert.deepEqual(result.after, progression(player));
  assert.equal(packets.filter(([type]) => type === "U").length, 3);
  assert.ok(packets.some(([type]) => type === "T"));
  assert.deepEqual([player.wood, player.food, player.stone, player.points], resources);
});

test("owner XP rejects invalid quantities without changing progression", t => {
  const { player } = fixture(t);
  const before = progression(player);
  for (const amount of [0, -1, 1.5, NaN, Infinity, "1000", null, {}, MAX_XP_GRANT + 1]) {
    assert.throws(() => grantExperience(player, amount), /xp_invalid/);
    assert.deepEqual(progression(player), before);
  }
});

test("owner XP respects the age cap and reports the amount actually applied", t => {
  const { player } = fixture(t);
  player.age = config.maxAge - 1;
  player.XP = 250;
  const result = grantExperience(player, 100);
  assert.equal(player.age, config.maxAge);
  assert.equal(result.granted, 50);
  assert.throws(() => grantExperience(player, 1), /xp_max_age/);
});

test("private XP command validates owner, reason and current life", t => {
  const { game, player } = fixture(t);
  const service = new ControlService({ accounts: { persistence: { pool: null } }, dataDir: "." });
  service.games = new Map([[game.key, game]]);
  const command = {
    apiVersion: 1, operationId: randomUUID(), actor: "owner", type: "xp",
    reason: "Recompensa de evento", expectedRevision: 0, expiresAt: Date.now() + 60000,
    target: { server: game.key, instanceId: game.instanceId, sessionId: player.id, lifeId: player.lifeId },
    payload: { amount: 1250 },
  };
  assert.ok(service.snapshot().capabilities.includes("xp"));
  assert.equal(service.snapshot().limits.xpGrant, MAX_XP_GRANT);
  assert.equal(service.validate(command).payload.amount, 1250);
  assert.throws(() => service.validate({ ...command, actor: "admin" }), /command_envelope/);
  assert.throws(() => service.validate({ ...command, reason: " " }), /command_envelope/);
  assert.throws(() => service.validate({ ...command, payload: { amount: 0 } }), /xp_invalid/);
  assert.equal(service.applyEffect(command).progression.granted, 1250);
  assert.deepEqual(service.players()[0].progression, progression(player));
  player.spawn(true);
  assert.throws(() => service.validate(command), /target_life_expired/);
  assert.equal(player.age, 1);
  assert.equal(player.XP, 0);
});
