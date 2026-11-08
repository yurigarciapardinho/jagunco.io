import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import cave from "../../../shared/cave.js";
import { patchCaveClient } from "../../../tools/cave-renderer-patch.mjs";

const fixture = 'function $p(e){if(e.teams)teams=e.teams;}\nfunction frame(){P.globalAlpha=1,P.strokeStyle=Ws,Xg(c,l)}';

test("cave patch rejects missing or ambiguous catalog and frame anchors", () => {
    assert.throws(() => patchCaveClient(""), /matched 0/);
    assert.throws(() => patchCaveClient(fixture + fixture), /matched 2/);
    assert.throws(() => patchCaveClient(fixture.replace("P.strokeStyle=Ws", "P.strokeStyle=other")), /matched 0/);
});

test("cave catalog survives partial admin metadata and reconnect replaces it", () => {
    const context = vm.createContext({ teams: [] });
    vm.runInContext(patchCaveClient(fixture) + ";this.catalog=$p;this.geometry=()=>jaguncoCave;", context);
    context.catalog({ cave: cave.BOSS_CAVE, teams: ["one"] });
    context.catalog({ admin: { active: true } });
    assert.equal(context.geometry(), cave.BOSS_CAVE);
    assert.deepEqual(context.teams, ["one"]);
    const replacement = { ...cave.BOSS_CAVE, revision: 2 };
    context.catalog({ cave: replacement });
    assert.equal(context.geometry(), replacement);
    context.catalog({ cave: null });
    assert.equal(context.geometry(), null);
});

test("cave renderer uses exact wall footprints and keeps the entrance clear", () => {
    const context = vm.createContext({});
    vm.runInContext(patchCaveClient(fixture) + ";this.catalog=$p;this.draw=drawJaguncoCave;", context);
    context.catalog({ cave: cave.BOSS_CAVE });
    const draws = [];
    let saved = 0, restored = 0;
    const ctx = { save() { saved++; }, restore() { restored++; }, fillRect(x,y,width,height) { draws.push({x,y,width,height,color:this.fillStyle}); } };
    context.draw(ctx, 0, 0, 14400, 14400);
    assert.equal(saved, 1);
    assert.equal(restored, 1);
    const walls = draws.filter(d => d.color === "#302e2c");
    assert.deepEqual(walls.map(({color,...box}) => box), cave.BOSS_CAVE.walls);
    const entrance = cave.BOSS_CAVE.entrance;
    for (const d of draws.filter(d => ["#302e2c","#57534e","#625e57"].includes(d.color))) {
        assert.ok(!(d.x < entrance.x + entrance.width && d.x + d.width > entrance.x &&
            d.y < entrance.y + entrance.height && d.y + d.height > entrance.y), "stone never covers the opening");
    }
    draws.length = 0;
    context.draw(ctx, 9000, 9000, 1000, 1000);
    assert.equal(draws.length, 0, "off-screen cave is culled");
});
