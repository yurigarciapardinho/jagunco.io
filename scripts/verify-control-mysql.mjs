#!/usr/bin/env node
// Isolated MySQL acceptance. The operator must stop the lab game first.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountStore } from "../server/src/api/store.js";
import { MySqlPersistence } from "../server/src/persistence/mysqlDriver.js";
import {
  ControlService,
  accountFingerprint,
} from "../server/src/control/service.js";
import { Game } from "../server/src/moomoo/server.js";
if (!process.env.CONTROL_TEST_DATABASE_URL)
  throw new Error("Use an isolated, stopped test database");
process.env.APP_SECRET = "synthetic-control-mysql-test-only";
delete process.env.CONTROL_SOCKET;
const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jagunco-command-test-")
  ),
  results = [],
  stores = [];
let game, service;
async function store() {
  const persistence = new MySqlPersistence({
    databaseUrl: process.env.CONTROL_TEST_DATABASE_URL,
    dataDir: directory,
    log: () => {},
  });
  const accounts = new AccountStore(directory, { persistence });
  await accounts.ready();
  stores.push(accounts);
  return accounts;
}
const test = async (name, job) => {
  await job();
  results.push({ name, pass: true });
  console.log("PASS " + name);
};
try {
  const accounts = await store();
  service = new ControlService({ accounts, dataDir: directory });
  await service.ready();
  game = new Game({
    key: "LC",
    capacity: 40,
    accounts,
    worldMap: {
      version: 1,
      width: 14400,
      height: 14400,
      objects: [],
      encounters: [],
    },
  });
  game.stop();
  await service.start(new Map([["LC", game]]));
  const account = accounts.accountForEmail("control-regression@jagunco.test");
  accounts.claimName(account, "ControlTest");
  accounts.save();
  await accounts.persistence.flush();
  const p = game.addPlayer({ send: () => {}, account, ip: "127.0.0.1" });
  p.setUserData({ name: "ControlTest", skin: 0 });
  p.spawn(true);
  const envelope = (
    type,
    payload,
    target = {
      server: "LC",
      instanceId: game.instanceId,
      sessionId: p.id,
      lifeId: p.lifeId,
    },
    expectedRevision = 0
  ) => ({
    apiVersion: 1,
    operationId: randomUUID(),
    actor: "owner",
    type,
    target: target.accountId
      ? {
          ...target,
          fingerprint: accountFingerprint(
            accounts.data.accounts[target.accountId]
          ),
        }
      : target,
    expectedRevision,
    payload,
    reason: "Isolated regression validation",
    expiresAt: Date.now() + 120000,
  });
  const lifeRevision = () =>
    service.state.get("life:" + game.instanceId + ":" + p.lifeId)?.revision ||
    0;
  const accountRevision = () =>
    service.state.get("account:" + account.id)?.revision || 0;
  await test("lost response cannot duplicate a transient grant", async () => {
    const c = envelope(
        "give",
        { resource: "wood", amount: 100 },
        undefined,
        lifeRevision()
      ),
      before = p.wood;
    const a = await service.execute(c),
      b = await service.execute(c);
    assert.equal(a.status, "applied");
    assert.equal(b.duplicate, true);
    assert.equal(p.wood, before + 100);
    await assert.rejects(
      service.execute({ ...c, payload: { resource: "wood", amount: 101 } }),
      /operation_reused/
    );
  });
  await test("stale revisions and previous lives cannot mutate a new life", async () => {
    await assert.rejects(
      service.execute(envelope("give", { resource: "wood", amount: 1 })),
      /revision_conflict/
    );
    const c = envelope(
      "power",
      { key: "god", value: 1 },
      undefined,
      lifeRevision()
    );
    p.spawn(true);
    await assert.rejects(service.execute(c), /target_life_expired/);
    assert.equal(p.powers.god, 0);
  });
  await test("failed effect after committed intent is never replayed", async () => {
    const c = envelope(
        "give",
        { resource: "wood", amount: 11 },
        undefined,
        lifeRevision()
      ),
      before = p.wood,
      apply = service.applyEffect;
    service.applyEffect = () => {
      throw new Error("injected before RAM effect");
    };
    const a = await service.execute(c);
    service.applyEffect = apply;
    const b = await service.execute(c);
    assert.equal(a.status, "uncertain");
    assert.equal(b.status, "uncertain");
    assert.equal(p.wood, before);
  });
  await test("persistent commit and live projection survive subsequent snapshots", async () => {
    const c = envelope(
      "role",
      { role: "admin" },
      { accountId: account.id },
      accountRevision()
    );
    await service.execute(c);
    accounts.save();
    await accounts.persistence.flush();
    const [[row]] = await accounts.persistence.pool.query(
      "SELECT role FROM accounts WHERE id=?",
      [account.id]
    );
    assert.equal(row.role, "admin");
    assert.equal(account.role, "admin");
    assert.equal(p.role, "admin");
  });
  await test("unknown commit fences snapshots until authoritative reconciliation", async () => {
    const c = envelope(
        "role",
        { role: "mod" },
        { accountId: account.id },
        accountRevision()
      ),
      base = service.pool;
    let lost = false;
    service.pool = {
      ...base,
      getConnection: async () => {
        const tx = await base.getConnection();
        return {
          ...tx,
          commit: async () => {
            await tx.commit();
            lost = true;
            throw new Error("injected lost commit ACK");
          },
        };
      },
      query: async (...args) => {
        if (lost) throw new Error("injected partition");
        return base.query(...args);
      },
    };
    await assert.rejects(service.execute(c), /commit_outcome_uncertain/);
    assert.equal(accounts.persistence.queue.fenced, true);
    accounts.save();
    const [[committed]] = await accounts.persistence.pool.query(
      "SELECT role FROM accounts WHERE id=?",
      [account.id]
    );
    assert.equal(committed.role, "mod");
    assert.equal(account.role, "admin");
    service.pool = base;
    await service.reconcile();
    await accounts.persistence.flush();
    assert.equal(accounts.persistence.queue.fenced, false);
    assert.equal(account.role, "mod");
    const [[after]] = await accounts.persistence.pool.query(
      "SELECT role FROM accounts WHERE id=?",
      [account.id]
    );
    assert.equal(after.role, "mod");
    assert.equal((await service.execute(c)).duplicate, true);
  });
  await test("a failure before commit produces no receipt or projection", async () => {
    const c = envelope(
        "role",
        { role: null },
        { accountId: account.id },
        accountRevision()
      ),
      base = service.pool;
    service.pool = {
      ...base,
      getConnection: async () => {
        const tx = await base.getConnection();
        return {
          ...tx,
          commit: async () => {
            throw new Error("injected before commit");
          },
          rollback: tx.rollback,
        };
      },
    };
    await assert.rejects(service.execute(c), /injected before commit/);
    service.pool = base;
    assert.equal(account.role, "mod");
    const [rows] = await accounts.persistence.pool.query(
      "SELECT operation_id FROM control_operations WHERE operation_id=?",
      [c.operationId]
    );
    assert.equal(rows.length, 0);
  });
  await test("rules expire locally and schedules survive service recovery", async () => {
    const eventId = randomUUID(),
      now = Date.now(),
      c = envelope(
        "event.upsert",
        {
          name: "Short event",
          server: "LC",
          start: now - 1000,
          end: now + 2000,
          rules: { gather: 2, animalReward: 3 },
        },
        { eventId }
      );
    await service.execute(c);
    assert.equal(service.rulesFor("LC", now).gather, 2);
    assert.equal(service.rulesFor("LC", now + 3000).gather, 1);
  });
  await test("stale account fingerprints detect edits outside the central", async () => {
    const c = envelope(
      "role",
      { role: "admin" },
      { accountId: account.id },
      accountRevision()
    );
    accounts.setVerdict(account.name, "shadow");
    await assert.rejects(service.execute(c), /account_changed/);
    assert.equal(account.role, "mod");
    accounts.setVerdict(account.name, "clear");
    await accounts.persistence.flush();
  });
  await test("new account hydration retains the durable role", async () => {
    const next = await store();
    assert.equal(next.data.accounts[account.id].role, "mod");
  });
  console.log(JSON.stringify({ pass: true, tests: results.length, results }));
} finally {
  game?.stop();
  await service?.close();
  for (const accounts of stores) await accounts.closePersistence();
  fs.rmSync(directory, { recursive: true, force: true });
}
