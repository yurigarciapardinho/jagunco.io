import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { patchBundle, patchAdminPanel } from "../../../tools/build-official-client.mjs";

const source = fs.readFileSync(new URL("../../../client-official/source/index-993d072d.js", import.meta.url), "utf8");
const defaults = { godlike: 0, god: 0, aura: 0, boss: 0, invisible: 0, size: 1, power: 1, speed: 1, health: 1 };

class Element {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.value = "";
        this.classList = { toggle: (name, on) => { this[name] = on; } };
    }
    appendChild(child) { this.children.push(child); return child; }
    get options() { return this.children.filter(child => child.tagName === "OPTION"); }
    querySelectorAll(selector) {
        const key = selector === "[data-admin-power]" ? "adminPower" : "adminMultiplier";
        const result = [];
        const visit = parent => {
            for (const child of parent.children) {
                if (key in child.dataset) result.push(child);
                visit(child);
            }
        };
        visit(this);
        return result;
    }
}

function fixture() {
    const nodes = Object.fromEntries(["adminMenu", "adminHolder", "adminButton"].map(id => [id, new Element()]));
    const sent = [];
    const context = vm.createContext({
        document: { getElementById: id => nodes[id], createElement: tag => new Element(tag) },
        qe: null, y: null, Be: ["original-team"], H: { send: (...args) => sent.push(args) },
        bt: { kinds: [], setKinds(kinds) { this.kinds = kinds; } }, m2() {},
        nt: new Element(), Vs: new Element(), sn() {}, qt() {}, ua() {},
        u: { removeAllChildren(element) { element.children.length = 0; }, checkTrusted: fn => fn }
    });
    const patched = patchAdminPanel(patchBundle(source));
    const start = patched.indexOf('const Al=document.getElementById("adminMenu");');
    const end = patched.indexOf("// END JAGUNCO_ADMIN_PANEL", start);
    const panel = patched.slice(start, end);
    const init = patched.match(/function \$p\(e\)\{[^}]+\}/)[0];
    const access = patched.match(/function X0\(\)\{[^}]+\}/)[0];
    vm.runInContext(panel + "\n" + init + "\n" + access, context);
    function receive(role = "admin", powers = {}, active = true) {
        context.update = { admin: { role, active, powers: { ...defaults, ...powers } } };
        vm.runInContext("$p(update)", context);
    }
    const buttons = () => nodes.adminHolder.querySelectorAll("[data-admin-power]");
    const selects = () => nodes.adminHolder.querySelectorAll("[data-admin-multiplier]");
    return { context, nodes, sent, receive, buttons, selects, run: script => vm.runInContext(script, context) };
}

test("panel keeps confirmed state until a server reply, including selectors and reopen", () => {
    const f = fixture();
    f.receive();
    f.run("adminToggle()");
    const god = f.buttons().find(button => button.dataset.adminPower === "god");
    god.onclick();
    assert.deepEqual(f.sent.at(-1), ["A", "god", 1]);
    assert.equal(god.textContent, "Ativar", "no optimistic success before the server reply");
    f.receive("admin", { god: 1 });
    assert.equal(god.textContent, "Ativado");
    const size = f.selects().find(select => select.dataset.adminMultiplier === "size");
    size.value = "2";
    size.onchange();
    assert.equal(size.value, "1", "unconfirmed browser selection is restored");
    assert.deepEqual(f.sent.at(-1), ["A", "size", 2]);
    f.receive("admin", { god: 1, size: 2 });
    assert.equal(size.value, "2");
    f.run("adminToggle(); adminToggle()");
    assert.equal(f.selects().find(select => select.dataset.adminMultiplier === "size").value, "2");
    assert.equal(f.buttons().find(button => button.dataset.adminPower === "god").textContent, "Ativado");
});

test("partial init metadata preserves catalogs and updates self without calling spawn", () => {
    const f = fixture();
    const setData = source.match(/this\.setData=function\(g\)\{[^}]+\}/)[0].replace("this.setData=", "");
    const player = { id: "self", sid: 7, items: [0, 4], weapons: [5, 9], wood: 1234, XP: 140,
        spawn() { throw new Error("metadata must never respawn self"); } };
    player.setData = vm.runInNewContext("(" + setData + ")");
    f.context.y = player;
    const inventory = player.items;
    f.context.update = { self: ["self", 7, "Admin", 5000, 3000, 0, 250, 500, 70, 0, 1, 0, null, -1, 0, 0, 0],
        admin: { role: "admin", active: true, powers: { ...defaults, size: 2, health: 5 } } };
    f.run("$p(update)");
    assert.deepEqual(f.context.Be, ["original-team"]);
    assert.equal(player.items, inventory);
    assert.deepEqual(player.weapons, [5, 9]);
    assert.equal(player.wood, 1234);
    assert.equal(player.XP, 140);
    assert.equal(player.maxHealth, 500);
    assert.equal(player.health, 250);
    assert.equal(player.scale, 70);
    f.context.update = { self: ["other", 9, "Other", 0, 0, 0, 100, 100, 35] };
    f.run("$p(update)");
    assert.equal(player.id, "self", "metadata for a different player is ignored");
});

test("revocation, death and disconnect close the menu and reject stale controls", () => {
    const f = fixture();
    f.receive();
    assert.equal(f.nodes.adminButton.style.display, "");
    f.run("adminToggle()");
    const stale = f.buttons()[0];
    for (const role of ["mod", null]) {
        f.receive(role);
        assert.equal(f.nodes.adminButton.style.display, "none");
        assert.equal(f.nodes.adminMenu.style.display, "none");
        const before = f.sent.length;
        stale.onclick();
        f.run("adminToggle()");
        assert.equal(f.sent.length, before);
        assert.equal(f.nodes.adminMenu.style.display, "none");
    }
    f.receive("admin", {}, false);
    assert.equal(f.nodes.adminButton.style.display, "none");
    f.receive();
    f.run("adminToggle(); adminDisconnect()");
    assert.equal(f.nodes.adminButton.style.display, "none");
    assert.equal(f.nodes.adminMenu.style.display, "none");
});

test("console multiplier values outside panel presets remain visible exactly", () => {
    const f = fixture();
    f.receive("admin", { size: 4.5, health: 50 });
    f.run("adminToggle()");
    assert.equal(f.selects().find(select => select.dataset.adminMultiplier === "size").value, "4.5");
    assert.equal(f.selects().find(select => select.dataset.adminMultiplier === "health").value, "50");
});

test("admin metadata patches retain exact anchor guards", () => {
    assert.throws(() => patchAdminPanel(""), /matched 0 times/);
    assert.throws(() => patchAdminPanel(source + source), /matched 2 times/);
    assert.throws(() => patchAdminPanel(source.replace("function $p(e){", "function changed(e){")), /matched 0 times/);
});
