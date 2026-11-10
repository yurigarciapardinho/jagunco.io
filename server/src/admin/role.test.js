import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { AccountStore } from "../api/store.js";
import { FilePersistence } from "../persistence/fileDriver.js";
import { createApiRouter } from "../api/routes.js";
import { AdminConsole } from "./console.js";
import { handlePacket } from "../network/packets.js";
import { makeGame, addPlayer, attachAnticheat, makeCtx } from "../testing/harness.test.js";

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-role-"));
    const store = new AccountStore(dir, { persistence: new FilePersistence({ dataDir: dir }) });
    await store.ready();
    t.after(async () => {
        await store.closePersistence();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const account = store.accountForEmail("target@example.test");
    store.claimName(account, "CaseAdmin");
    account.role = "admin";
    const owner = store.accountForEmail("owner@example.test");
    store.claimName(owner, "ControlAdmin");
    owner.role = "admin";
    store.save();
    const first = makeGame(t);
    const second = makeGame(t);
    const live = addPlayer(first, { account });
    const suspended = addPlayer(second, { account });
    attachAnticheat(live);
    attachAnticheat(suspended);
    second.suspendPlayer(suspended);
    const unrelated = addPlayer(first, { account: owner });
    const console = new AdminConsole({
        games: new Map([[first.key, first], [second.key, second]]),
        accounts: store, moderation: {}, build: {}, dataDir: dir, log: () => {}
    });
    return { store, account, owner, first, second, live, suspended, unrelated, console };
}

for (const typed of ["CaseAdmin", "caseadmin", "CASEADMIN"]) {
    test("console revokes live and suspended accounts by identity: " + typed, async t => {
        const f = await fixture(t);
        const result = f.console.execute("role " + typed + " none");
        assert.ok(!result[0].startsWith("error:"));
        assert.equal(f.account.role, null);
        for (const [game, player] of [[f.first, f.live], [f.second, f.suspended]]) {
            assert.equal(player.role, null, "no cached admin role after revocation");
            const before = player.wood;
            handlePacket(makeCtx(game), player, "A", ["give", 0, 10000]);
            assert.equal(player.wood, before, "revoked player cannot execute an admin packet");
        }
        assert.equal(f.unrelated.role, "admin", "a different account is unaffected");
        f.second.rejoinPlayer(f.suspended, { send: () => {}, ip: "127.0.0.1" });
        assert.equal(f.suspended.role, null);
    });
}

test("HTTP role changes refuse promotion even for an authenticated admin", async t => {
    const f = await fixture(t);
    const app = express();
    app.use("/api", createApiRouter({
        store: f.store, moderation: {}, servers: { list: () => [] },
        game: { setAccountRole: (id, role) => {
            for (const game of [f.first, f.second]) game.setAccountRole(id, role);
        } }
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    const url = "http://127.0.0.1:" + server.address().port + "/api/mod/role";
    const post = body => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    for (const token of [f.store.issueToken(f.owner), f.store.issueToken(f.account), "invalid"]) {
        const response = await post({ auth: token, name: "CaseAdmin", role: "mod" });
        assert.equal(response.status, 403);
        assert.equal(f.live.role, "admin");
        assert.equal(f.suspended.role, "admin");
    }
});

test("resuming a player refreshes the current account role", async t => {
    const f = await fixture(t);
    f.account.role = null;
    f.second.rejoinPlayer(f.suspended, { send: () => {}, ip: "127.0.0.1" });
    assert.equal(f.suspended.role, null);
});
