// FILE MODE (development) tests: without DATABASE_URL the stores keep the original JSON
// behaviour, including the debounced writes and restart reload.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPersistence } from "./index.js";
import { AccountStore } from "../api/store.js";
import { Chat } from "../api/chat.js";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-file-"));
}

test("factory returns the file driver without DATABASE_URL (dev mode)", async () => {
    const dir = tmpDir();
    const persistence = createPersistence({ dataDir: dir, databaseUrl: "", log: () => {} });
    assert.equal(persistence.mode, "file");
    await persistence.ready();
    await persistence.close();
});

test("factory refuses file mode in production", () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        assert.throws(() => createPersistence({ dataDir: tmpDir(), databaseUrl: "", log: () => {} }), /DATABASE_URL is required in production/);
    } finally {
        process.env.NODE_ENV = env;
    }
});

test("AccountStore file mode: data survives a restart (accounts.json)", async () => {
    const dir = tmpDir();
    const store = new AccountStore(dir);
    await store.ready();
    const account = store.accountForEmail("dev@example.com");
    assert.equal(store.claimName(account, "Dev_Name").status, 200);
    store.recordLife(account, { kills: 4, died: false, damage: 10, healing: 0, wood: 0, food: 0, stone: 0, gold: 0, animalDamage: 0, playtime: 1, score: 50, animalKills: {}, bossKills: 0 });
    await store.persistence.flush();

    const reloaded = new AccountStore(dir);
    await reloaded.ready();
    const again = reloaded.accountByEmail("dev@example.com");
    assert.equal(again.name, "Dev_Name");
    assert.equal(again.stats.kills, 4);
});

test("Chat file mode: history survives a restart (chat.json)", async () => {
    const dir = tmpDir();
    const stream = { sendTo() {} };
    const game = { whereIs: () => null, playerBySession: () => null };
    const store = new AccountStore(dir);
    const a = store.accountForEmail("a@example.com");
    const b = store.accountForEmail("b@example.com");
    store.claimName(a, "Alpha");
    store.claimName(b, "Beta");
    const { request } = store.createFriendRequest(a.id, b.id);
    store.answerFriendRequest(b.id, request.id, true);
    const chat = new Chat({ dataDir: dir, store, stream, game, log: () => {} });
    await chat.ready();
    chat.whisper(a, "Beta", "persist me");
    await store.persistence.flush();

    const store2 = new AccountStore(dir);
    const chat2 = new Chat({ dataDir: dir, store: store2, stream, game, log: () => {} });
    await chat2.ready();
    const a2 = store2.accountByEmail("a@example.com");
    assert.equal(chat2.history(a2, "whisper", "Beta").messages.length, 1);
    assert.equal(chat2.history(a2, "whisper", "Beta").messages[0].text, "persist me");
});

test("AccountStore signs tokens with APP_SECRET when it is set", async () => {
    const dir = tmpDir();
    const env = process.env.APP_SECRET;
    process.env.APP_SECRET = "unit-test-secret";
    try {
        const store = new AccountStore(dir);
        const account = store.accountForEmail("tok@example.com");
        const token = store.issueToken(account);
        await store.persistence.flush(); // debounced accounts.json write
        // same store, file secret on disk: a store WITHOUT APP_SECRET must not verify it
        delete process.env.APP_SECRET;
        const other = new AccountStore(dir);
        assert.equal(other.verifyToken(token), null);
        process.env.APP_SECRET = "unit-test-secret";
        const again = new AccountStore(dir);
        assert.equal(again.verifyToken(token).id, account.id);
    } finally {
        if (env === undefined) delete process.env.APP_SECRET;
        else process.env.APP_SECRET = env;
    }
});

test("AccountStore fails explicitly in production without APP_SECRET", () => {
    const dir = tmpDir();
    // injected file persistence (created in dev) so only the APP_SECRET rule is exercised
    const persistence = createPersistence({ dataDir: dir, databaseUrl: "", log: () => {} });
    const env = { NODE_ENV: process.env.NODE_ENV, APP_SECRET: process.env.APP_SECRET };
    delete process.env.APP_SECRET;
    process.env.NODE_ENV = "production";
    try {
        assert.throws(() => new AccountStore(dir, { persistence }), /APP_SECRET must be set in production/);
    } finally {
        if (env.APP_SECRET !== undefined) process.env.APP_SECRET = env.APP_SECRET;
        process.env.NODE_ENV = env.NODE_ENV;
    }
});
