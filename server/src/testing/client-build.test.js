import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { patchBundle } from "../../../tools/build-official-client.mjs";

const source = fs.readFileSync(new URL("../../../client-official/source/index-993d072d.js", import.meta.url), "utf8");

test("client build routes local servers through this host", () => {
    const patched = patchBundle(source);
    const routing = patched.match(/function Vd\(e\)\{[^}]+\}/)[0];
    const resolve = vm.runInNewContext("(" + routing + ")", { location: { host: "localhost:4500" } });
    assert.equal(resolve({ region: "local", key: "LC" }), "localhost:4500/s/LC");
    assert.equal(resolve({ region: "local", key: "MB" }), "localhost:4500/s/MB");
});

test("client build exposes and wires the panel only for admins", () => {
    const patched = patchBundle(source);
    const visibility = patched.match(/function X0\(\)\{[^}]+\}/)[0];
    for (const role of ["admin", "mod", null]) {
        const button = { style: {} };
        vm.runInNewContext("(" + visibility + ")()", {
            qe: role,
            document: { getElementById: () => button }
        });
        assert.equal(button.style.display, role === "admin" ? "" : "none");
    }
    assert.ok(patched.includes("n.onclick=u.checkTrusted(function(){adminToggle()})"));
    assert.ok(!patched.includes('fn(wa,"Forgot password?",p0)'));
    assert.ok(!patched.includes('fn(wa,"Use a code",p0)'));
    assert.ok(patched.includes("antiDebug:!0,detectUserscripts:!0"));
});

test("client build still rejects missing and ambiguous patch anchors", () => {
    assert.throws(() => patchBundle(""), /matched 0 times/);
    assert.throws(() => patchBundle(source + source), /matched 2 times/);
});
