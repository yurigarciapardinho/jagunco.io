import test from "node:test";
import assert from "node:assert/strict";
import contract from "../../../shared/control-contract.js";
import { Game } from "../moomoo/server.js";
import { WriteQueue } from "../persistence/queue.js";
const empty = () => ({
  version: 1,
  width: 14400,
  height: 14400,
  objects: [],
  encounters: [],
});
test("authoring preserves explicit cactus species and protects cave access", () => {
  const map = empty();
  map.objects.push({
    id: "cactus",
    kind: "cactus",
    x: 6000,
    y: 13000,
    scale: 80,
  });
  assert.equal(contract.validateMap(map).valid, true);
  map.objects[0].y = 6000;
  assert.equal(contract.validateMap(map).errors[0].code, "biome");
  map.objects[0] = { id: "tree", kind: "tree", x: 2600, y: 5100, scale: 150 };
  assert.equal(contract.validateMap(map).errors[0].code, "cave_protected");
  map.objects = [
    { id: "a", kind: "stone", x: 6000, y: 5000, scale: 80 },
    { id: "b", kind: "stone", x: 6100, y: 5000, scale: 80 },
  ];
  assert.ok(
    contract.validateMap(map).errors.some(e => e.code.startsWith("overlap"))
  );
});
test("canonical loader creates indexed damaging cacti and fixed physical guardians", t => {
  const map = empty();
  map.objects = [
    { id: "cactus", kind: "cactus", x: 6000, y: 13000, scale: 80 },
    { id: "wall", kind: "building", item: 3, x: 8000, y: 5000, scale: 50 },
  ];
  const g = new Game({ key: "TEST", capacity: 40, worldMap: map });
  g.stop();
  t.after(() => g.stop());
  const cactus = g.game_objects.find(o => o.authoringId === "cactus");
  assert.equal(cactus.dmg, 20);
  assert.ok(cactus.gridLocations.length > 0);
  assert.ok(g.ais.some(a => a.index === 6 && a.homeBounds));
  assert.ok(g.ais.some(a => a.index === 8 && a.homeBounds));
  assert.ok(g.ais.some(a => a.index === 7 && a.homeBounds));
  assert.equal(
    g.object_manager.checkItemLocation(6000, 13000, 50, 1, null, true),
    false
  );
});
test("each world allocates advertised normal capacity plus ten staff slots", t => {
  for (const capacity of [40, 80]) {
    const g = new Game({ key: "SLOTS", capacity });
    g.stop();
    t.after(() => g.stop());
    const players = [];
    for (let i = 0; i < capacity + 10; i++)
      players.push(g.addPlayer({ send: () => {}, ip: "127.0.0.1" }));
    assert.ok(players.every(Boolean));
    assert.equal(new Set(players.map(p => p.sid)).size, capacity + 10);
    assert.equal(g.addPlayer({ send: () => {}, ip: "127.0.0.1" }), null);
    g.removePlayer(players[20]);
    assert.equal(g.addPlayer({ send: () => {}, ip: "127.0.0.1" }).sid, 20);
  }
});
test("critical queue jobs reject independently and preserve serialization", async () => {
  const q = new WriteQueue();
  let release;
  const order = [];
  q.enqueue("snapshot", async () => {
    await new Promise(r => (release = r));
    order.push("snapshot");
  });
  const a = q.runExclusive(async () => {
    order.push("commit");
    throw new Error("db_failed");
  });
  const b = q.runExclusive(async () => {
    order.push("project");
    return 17;
  });
  const rejected = assert.rejects(a, /db_failed/);
  release();
  await rejected;
  assert.equal(await b, 17);
  assert.deepEqual(order, ["snapshot", "commit", "project"]);
  await q.close();
  await assert.rejects(
    q.runExclusive(() => {}),
    /queue_closed/
  );
});
test("rules reject unsupported execution and out of range multipliers", () => {
  assert.deepEqual(contract.validateRules({}), { gather: 1, animalReward: 1 });
  assert.throws(() => contract.validateRules({ gather: 0 }), /range/);
  assert.throws(
    () => contract.validateRules({ script: "process.exit()" }),
    /unsupported/
  );
});
test("authored player entries use native collision checks and preserve life identity rules", t => {
  const map = empty();
  map.spawns = [{ id: "start", x: 9000, y: 3000 }];
  const g = new Game({ key: "SPAWN", capacity: 40, worldMap: map });
  g.stop();
  t.after(() => g.stop());
  const p = g.addPlayer({ send: () => {}, ip: "127.0.0.1" });
  p.setUserData({ name: "MapSpawn", skin: 0 });
  p.spawn(true);
  assert.equal(p.x, 9000);
  assert.equal(p.y, 3000);
  const before = p.lifeId;
  p.spawn(true);
  assert.notEqual(p.lifeId, before);
  assert.equal(p.x, 9000);
  const invalid = empty();
  invalid.spawns = [{ id: "blocked", x: 2600, y: 5150 }];
  assert.equal(contract.validateMap(invalid).valid, false);
});
