import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import express from "express";
import contract from "../../../shared/control-contract.js";
import { hats, accessories } from "../moomoo/modules/store.js";
import { AI_TYPES } from "../moomoo/modules/aiManager.js";

export const hash = value =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const accountFingerprint = a =>
  hash({
    role: a.role || null,
    verdict: a.verdict || null,
    look: a.look || null,
    segment: a.segment || "organic",
  });
const json = value => (typeof value === "string" ? JSON.parse(value) : value);
const error = (code, status = 400) =>
  Object.assign(new Error(code), { status });
const uuid = value =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value
  );
const safeAccount = a => ({
  id: a.id,
  name: a.name || "",
  email: a.email,
  role: a.role || null,
  verdict: a.verdict || null,
  createdAt: a.createdAt,
  stats: a.stats || {},
  look: a.look || null,
});

export class ControlService {
  constructor({ accounts, dataDir, log = () => {}, assetManifest = null }) {
    this.accounts = accounts;
    this.dataDir = dataDir;
    this.log = log;
    this.assetManifest = assetManifest;
    const raw = accounts.persistence.pool;
    const query = (client, sql, values) =>
      client.query(
        typeof sql === "string" ? { sql, timeout: 3000 } : sql,
        values
      );
    this.pool = raw
      ? {
          query: (sql, values) => query(raw, sql, values),
          getConnection: async () => {
            const tx = await raw.getConnection();
            return {
              query: (sql, values) => query(tx, sql, values),
              beginTransaction: () => query(tx, "START TRANSACTION"),
              commit: () => query(tx, "COMMIT"),
              rollback: () => query(tx, "ROLLBACK"),
              release: () => tx.release(),
            };
          },
        }
      : null;
    this.queue = accounts.persistence.queue;
    this.enabled = !!process.env.CONTROL_SOCKET;
    this.instanceId = randomUUID();
    this.state = new Map();
    this.recent = new Map();
    this.events = [];
    this.dropped = 0;
    this.unresolved = new Map();
    this.startedAt = Date.now();
    this.loop = monitorEventLoopDelay({ resolution: 20 });
  }
  async ready() {
    if (
      this.enabled &&
      (!this.pool ||
        !process.env.CONTROL_SECRET ||
        process.env.CONTROL_SECRET.length < 32 ||
        process.env.APP_PURPOSE === "preview")
    )
      throw error("control_requires_mysql_and_own_secret");
    if (this.pool) {
      const [rows] = await this.pool.query(
        "SELECT entity_key, revision, payload FROM control_state"
      );
      for (const row of rows)
        this.state.set(row.entity_key, {
          revision: Number(row.revision),
          payload: json(row.payload),
        });
      // A process restart cannot complete an old effect in a previous life.
      await this.pool.query(
        "UPDATE control_operations SET status=IF(type IN ('role','verdict','look','segment','map.publish','rules.publish','event.upsert','event.cancel'),'applied','uncertain'), finished_at=? WHERE status='committed'",
        [Date.now()]
      );
      for (const [key, value] of this.state)
        if (
          key.startsWith("account:") &&
          this.accounts.data.accounts[key.slice(8)]
        )
          this.accounts.data.accounts[key.slice(8)].segment =
            value.payload.segment || "organic";
    }
    if (process.env.OWNER_EMAIL && !this.state.has("owner.bootstrap")) {
      const marker = path.join(this.dataDir, "owner-bootstrap.json");
      if (!this.pool && fs.existsSync(marker)) return;
      const owner = this.accounts.accountForEmail(process.env.OWNER_EMAIL);
      this.accounts.save();
      await this.accounts.persistence.flush();
      if (this.pool) {
        await this.queue.runExclusive(async () => {
          const tx = await this.pool.getConnection();
          try {
            await tx.beginTransaction();
            const [rows] = await tx.query(
              "SELECT id FROM accounts WHERE id=?",
              [owner.id]
            );
            if (!rows.length) throw error("owner_bootstrap_not_persisted");
            await tx.query("UPDATE accounts SET role='admin' WHERE id=?", [
              owner.id,
            ]);
            await tx.query(
              "INSERT IGNORE INTO control_state VALUES ('owner.bootstrap',1,?)",
              [JSON.stringify({ accountId: owner.id })]
            );
            await tx.commit();
            owner.role = "admin";
          } catch (e) {
            await tx.rollback().catch(() => {});
            throw e;
          } finally {
            tx.release();
          }
        });
      } else {
        owner.role = "admin";
        this.accounts.save();
        await this.accounts.persistence.flush();
        fs.writeFileSync(marker, JSON.stringify({ accountId: owner.id }), {
          mode: 0o600,
        });
      }
      this.state.set("owner.bootstrap", {
        revision: 1,
        payload: { accountId: owner.id },
      });
    }
  }
  mapFor(key) {
    if (process.env.APP_PURPOSE === "preview" && process.env.PREVIEW_MAP_FILE) {
      const file = path.resolve(process.env.PREVIEW_MAP_FILE);
      if (!file.startsWith(path.resolve(this.dataDir) + path.sep))
        throw error("preview_map_path");
      const check = contract.validateMap(json(fs.readFileSync(file, "utf8")));
      if (!check.valid) throw error("preview_map_invalid");
      return check.map;
    }
    const value = this.state.get("map:" + key)?.payload;
    if (!value) return null;
    const check = contract.validateMap(value.map);
    if (!check.valid || hash(check.map) !== value.sha256)
      throw error("published_map_corrupt");
    return check.map;
  }
  rulesFor(key, now = Date.now()) {
    if (
      process.env.APP_PURPOSE === "preview" &&
      process.env.PREVIEW_RULES_FILE
    ) {
      const file = path.resolve(process.env.PREVIEW_RULES_FILE);
      if (!file.startsWith(path.resolve(this.dataDir) + path.sep))
        throw error("preview_rules_path");
      return contract.validateRules(json(fs.readFileSync(file, "utf8")));
    }
    let value = contract.validateRules(
      this.state.get("rules:" + key)?.payload || {}
    );
    for (const [name, { payload: e }] of this.state)
      if (
        name.startsWith("event:") &&
        !e.cancelled &&
        e.server === key &&
        now >= e.start &&
        now < e.end
      )
        value = e.rules;
    return value;
  }
  emit(kind, data = {}) {
    if (!this.pool) return;
    if (this.events.length >= 1000) {
      this.dropped++;
      return;
    }
    if (data.accountId)
      data = {
        ...data,
        segment:
          this.accounts.data.accounts[data.accountId]?.segment ||
          this.state.get("account:" + data.accountId)?.payload?.segment ||
          "organic",
      };
    this.events.push({ id: randomUUID(), at: Date.now(), kind, data });
  }
  async flushEvents() {
    if (!this.pool || this.flushing || !this.events.length) return;
    this.flushing = true;
    const batch = this.events.splice(0, 100);
    try {
      await this.pool.query(
        "INSERT IGNORE INTO control_telemetry (event_id, at, kind, payload) VALUES ?",
        [batch.map(e => [e.id, e.at, e.kind, JSON.stringify(e.data)])]
      );
    } catch {
      this.events.unshift(...batch);
      this.dropped += Math.max(0, this.events.length - 1000);
      this.events.splice(1000);
      this.log("control: telemetry write unavailable");
    } finally {
      this.flushing = false;
    }
  }
  snapshot() {
    return {
      apiVersion: 1,
      catalogHash: this.assetManifest?.catalogSha256 || null,
      clientBundleSha256: this.assetManifest?.clientBundleSha256 || null,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      now: Date.now(),
      persistence: this.accounts.persistence.mode,
      capabilities: [
        "role",
        "verdict",
        "look",
        "segment",
        "power",
        "give",
        "teleport",
        "spawn",
        "kick",
        "map.publish",
        "rules.publish",
        "event.upsert",
        "event.cancel",
      ],
      queue: {
        fenced: !!this.queue?.fenced,
        unresolved: this.unresolved.size,
        pending: this.queue?.pending?.size || 0,
        errors: this.queue?.errors || 0,
        telemetryBacklog: this.events.length,
        telemetryDropped: this.dropped,
      },
      worlds: [...this.games.values()].map(g => ({
        key: g.key,
        instanceId: g.instanceId,
        capacity: g.capacity,
        hardSlots: g.sids.length,
        connected: g.players.filter(p => !p.disconnectedAt).length,
        alive: g.players.filter(p => p.alive).length,
        guests: g.players.filter(p => !p.account && !p.disconnectedAt).length,
        authenticated: g.players.filter(p => p.account && !p.disconnectedAt)
          .length,
        suspended: g.players.filter(p => p.disconnectedAt).length,
        activeMap: g.mapSha256,
        desiredMap: this.state.get("map:" + g.key)?.payload?.sha256 || null,
        mapRevision: this.state.get("map:" + g.key)?.revision || 0,
        rulesRevision: this.state.get("rules:" + g.key)?.revision || 0,
        rules: this.rulesFor(g.key),
        baseRules:
          this.state.get("rules:" + g.key)?.payload ||
          contract.validateRules({}),
        tick: g.tickMetric || null,
      })),
      events: [...this.state]
        .filter(([k]) => k.startsWith("event:"))
        .map(([key, state]) => ({ key, ...state })),
    };
  }
  players() {
    return [...this.games.values()].flatMap(g =>
      g.players.map(p => ({
        server: g.key,
        instanceId: g.instanceId,
        lifeId: p.lifeId || null,
        sessionId: p.id,
        accountId: p.account?.id || null,
        name: p.name,
        role: p.role || null,
        alive: !!p.alive,
        suspended: !!p.disconnectedAt,
        x: p.x,
        y: p.y,
        powers: p.powers,
        revision:
          this.state.get("life:" + g.instanceId + ":" + p.lifeId)?.revision ||
          0,
        resources: {
          wood: p.wood,
          food: p.food,
          stone: p.stone,
          gold: p.points,
        },
      }))
    );
  }
  target(command) {
    const g = this.games.get(command.target?.server);
    const p = g?.players.find(p => p.id === command.target?.sessionId);
    if (
      !g ||
      g.instanceId !== command.target?.instanceId ||
      !p ||
      !p.alive ||
      p.lifeId !== command.target?.lifeId
    )
      throw error("target_life_expired", 409);
    return { g, p };
  }
  validate(c) {
    if (
      c.apiVersion !== 1 ||
      !uuid(c.operationId) ||
      !Number.isInteger(c.expectedRevision) ||
      c.expectedRevision < 0 ||
      typeof c.actor !== "string" ||
      c.actor !== "owner" ||
      typeof c.reason !== "string" ||
      c.reason.trim().length < 3 ||
      c.reason.length > 240 ||
      !Number.isFinite(c.expiresAt) ||
      c.expiresAt <= Date.now() ||
      c.expiresAt > Date.now() + 120000
    )
      throw error("command_envelope");
    if (!this.snapshot().capabilities.includes(c.type))
      throw error("command_unsupported");
    const b = c.payload || {};
    let entity, payload;
    if (["role", "verdict", "look", "segment"].includes(c.type)) {
      const a = this.accounts.data.accounts[c.target?.accountId];
      if (!a) throw error("account_missing", 404);
      if (c.target.fingerprint !== accountFingerprint(a))
        throw error("account_changed", 409);
      entity = "account:" + a.id;
      if (c.type === "role") {
        if (![null, "mod", "admin"].includes(b.role))
          throw error("role_invalid");
        payload = { role: b.role };
      }
      if (c.type === "verdict") {
        if (![null, "ban", "shadow"].includes(b.verdict))
          throw error("verdict_invalid");
        payload = { verdict: b.verdict };
      }
      if (c.type === "segment") {
        if (!["organic", "test", "owner"].includes(b.segment))
          throw error("segment_invalid");
        payload = { segment: b.segment };
      }
      if (c.type === "look") {
        if (
          !b.look ||
          !Number.isInteger(b.look.hat) ||
          b.look.hat < 0 ||
          ![0, ...hats.map(h => h.id)].includes(b.look.hat) ||
          !Number.isInteger(b.look.acc) ||
          b.look.acc < 0 ||
          ![0, ...accessories.map(h => h.id)].includes(b.look.acc)
        )
          throw error("look_invalid");
        payload = {
          look: { ...(a.look || {}), hat: b.look.hat, acc: b.look.acc },
        };
      }
    } else if (c.type === "map.publish") {
      if (!this.games.has(c.target?.server)) throw error("server_missing");
      const check = contract.validateMap(b.map);
      if (!check.valid)
        throw error("map_invalid:" + JSON.stringify(check.errors.slice(0, 3)));
      entity = "map:" + c.target.server;
      payload = { sha256: hash(check.map), map: check.map };
    } else if (c.type === "rules.publish") {
      if (!this.games.has(c.target?.server)) throw error("server_missing");
      entity = "rules:" + c.target.server;
      payload = contract.validateRules(b);
    } else if (c.type.startsWith("event.")) {
      if (!uuid(c.target?.eventId)) throw error("event_id");
      entity = "event:" + c.target.eventId;
      if (c.type === "event.cancel") {
        if (!this.state.has(entity)) throw error("event_missing");
        payload = { ...this.state.get(entity).payload, cancelled: true };
      } else {
        if (
          !this.games.has(b.server) ||
          !Number.isFinite(b.start) ||
          !Number.isFinite(b.end) ||
          b.end <= Date.now() ||
          b.start >= b.end ||
          b.end - b.start > 7 * 86400000 ||
          b.start > Date.now() + 30 * 86400000 ||
          typeof b.name !== "string" ||
          !b.name.trim() ||
          b.name.length > 80
        )
          throw error("event_invalid");
        for (const [key, { payload: e }] of this.state)
          if (
            key !== entity &&
            key.startsWith("event:") &&
            e.server === b.server &&
            !e.cancelled &&
            b.start < e.end &&
            b.end > e.start
          )
            throw error("event_overlap", 409);
        payload = {
          name: b.name,
          server: b.server,
          start: b.start,
          end: b.end,
          rules: contract.validateRules(b.rules),
          cancelled: false,
        };
      }
    } else {
      const { g, p } = this.target(c);
      entity = "life:" + g.instanceId + ":" + p.lifeId;
      if (c.type === "power") {
        const flags = ["god", "godlike", "aura", "boss", "invisible"],
          limits = { size: 5, power: 100, speed: 20, health: 50 };
        if (
          !b.key ||
          ![...flags, ...Object.keys(limits)].includes(b.key) ||
          !Number.isFinite(b.value) ||
          (flags.includes(b.key)
            ? ![0, 1].includes(b.value)
            : b.value < 1 || b.value > limits[b.key])
        )
          throw error("power_invalid");
      }
      if (
        c.type === "give" &&
        (!["wood", "food", "stone", "gold"].includes(b.resource) ||
          !Number.isInteger(b.amount) ||
          b.amount < 1 ||
          b.amount > 100000)
      )
        throw error("grant_invalid");
      if (
        c.type === "teleport" &&
        (!Number.isFinite(b.x) ||
          !Number.isFinite(b.y) ||
          b.x < p.scale ||
          b.y < p.scale ||
          b.x > 14400 - p.scale ||
          b.y > 14400 - p.scale ||
          !g.object_manager.checkItemLocation(b.x, b.y, p.scale, 1, null, true))
      )
        throw error("teleport_blocked");
      if (
        c.type === "spawn" &&
        (!Number.isInteger(b.index) ||
          !AI_TYPES[b.index] ||
          g.ais.filter(a => a.active && a.despawnOnDeath).length >= 50)
      )
        throw error("spawn_invalid");
      payload = { ...b };
    }
    return { entity, payload };
  }
  async execute(c) {
    // Duplicate lookup precedes expiry/life checks: retry only observes a receipt.
    if (!uuid(c.operationId)) throw error("operation_id");
    const digest = hash(c);
    return this.queue.runExclusive(async () => {
      const [old] = await this.pool.query(
        "SELECT payload_hash, status, result_json FROM control_operations WHERE operation_id=?",
        [c.operationId]
      );
      if (old.length) {
        if (old[0].payload_hash !== digest)
          throw error("operation_reused", 409);
        return {
          operationId: c.operationId,
          status: old[0].status,
          ...json(old[0].result_json || "{}"),
          duplicate: true,
        };
      }
      const { entity, payload } = this.validate(c);
      const prior = this.state.get(entity) || { revision: 0, payload: null };
      const patch = { ...payload };
      if (entity.startsWith("account:")) {
        const a = this.accounts.data.accounts[c.target.accountId];
        Object.assign(payload, {
          role: a.role || null,
          verdict: a.verdict || null,
          look: a.look || null,
          segment: prior.payload?.segment || "organic",
          ...patch,
        });
      }
      if (prior.revision !== c.expectedRevision)
        throw error("revision_conflict", 409);
      const revision = prior.revision + 1,
        persistent = [
          "role",
          "verdict",
          "look",
          "segment",
          "map.publish",
          "rules.publish",
          "event.upsert",
          "event.cancel",
        ].includes(c.type);
      const result = {
        revision,
        entity,
        before: prior.payload,
        after: payload,
      };
      if (entity.startsWith("account:")) {
        const a = this.accounts.data.accounts[c.target.accountId];
        result.before = Object.fromEntries(
          Object.keys(patch).map(k => [k, a[k] ?? null])
        );
        result.after = patch;
      }
      const tx = await this.pool.getConnection();
      let committing = false;
      try {
        await tx.beginTransaction();
        if (["role", "verdict", "look", "segment"].includes(c.type)) {
          const column = c.type === "look" ? "look_json" : c.type;
          if (c.type !== "segment")
            await tx.query(`UPDATE accounts SET ${column}=? WHERE id=?`, [
              c.type === "look" ? JSON.stringify(patch.look) : patch[c.type],
              c.target.accountId,
            ]);
        }
        await tx.query(
          "INSERT INTO control_state (entity_key, revision, payload) VALUES (?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision), payload=VALUES(payload)",
          [entity, revision, JSON.stringify(payload)]
        );
        await tx.query(
          "INSERT INTO control_operations (operation_id,payload_hash,type,actor,reason,target_json,status,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            c.operationId,
            digest,
            c.type,
            c.actor,
            c.reason,
            JSON.stringify(c.target),
            "committed",
            JSON.stringify(result),
            Date.now(),
          ]
        );
        committing = true;
        await tx.commit();
      } catch (e) {
        await tx.rollback().catch(() => {});
        if (!committing) throw e;
        let found;
        try {
          const [rows] = await this.pool.query(
            "SELECT operation_id FROM control_operations WHERE operation_id=?",
            [c.operationId]
          );
          found = !!rows.length;
        } catch {
          this.queue.pause();
          this.unresolved.set(c.operationId, {
            c,
            entity,
            payload,
            patch,
            revision,
            persistent,
          });
          setTimeout(() => void this.reconcile(), 1000).unref();
          throw error("commit_outcome_uncertain", 503);
        }
        if (!found) throw e;
      } finally {
        tx.release();
      }
      this.state.set(entity, { revision, payload });
      if (persistent) {
        this.project(c, patch);
        try {
          await this.pool.query(
            "UPDATE control_operations SET status='applied',finished_at=? WHERE operation_id=?",
            [Date.now(), c.operationId]
          );
        } catch {
          this.recent.set(c.operationId, { status: "applied", ...result });
          this.unresolved.set(c.operationId, {
            c,
            entity,
            payload,
            patch,
            revision,
            persistent,
            applied: true,
          });
          setTimeout(() => void this.reconcile(), 1000).unref();
          return { operationId: c.operationId, status: "uncertain", revision };
        }
        return { operationId: c.operationId, status: "applied", ...result };
      }
      let status = "applied";
      try {
        this.applyEffect(c);
      } catch (e) {
        status = e.status === 409 ? "expired" : "uncertain";
        result.error = e.status ? e.message : "effect_failed";
      }
      this.recent.set(c.operationId, { status, ...result });
      if (this.recent.size > 1000)
        this.recent.delete(this.recent.keys().next().value);
      try {
        await this.pool.query(
          "UPDATE control_operations SET status=?,result_json=?,finished_at=? WHERE operation_id=?",
          [status, JSON.stringify(result), Date.now(), c.operationId]
        );
      } catch {
        this.unresolved.set(c.operationId, {
          c,
          entity,
          payload,
          patch,
          revision,
          persistent,
          applied: true,
        });
        setTimeout(() => void this.reconcile(), 1000).unref();
        return { operationId: c.operationId, status: "uncertain", revision };
      }
      return { operationId: c.operationId, status, ...result };
    });
  }
  project(c, patch) {
    if (!["role", "verdict", "look", "segment"].includes(c.type)) return;
    const account = this.accounts.data.accounts[c.target.accountId];
    Object.assign(account, patch);
    for (const g of this.games.values()) {
      if (c.type === "role") g.setAccountRole(account.id, account.role);
      if (c.type === "verdict") {
        g.setShadow(account.id, account.verdict === "shadow");
        if (account.verdict === "ban")
          g.kickAccount(account.id, "Conta suspensa");
      }
    }
  }
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const [id, pending] of this.unresolved) {
        const [rows] = await this.pool.query(
          "SELECT operation_id FROM control_operations WHERE operation_id=?",
          [id]
        );
        if (rows.length) {
          this.state.set(pending.entity, {
            revision: pending.revision,
            payload: pending.payload,
          });
          if (pending.persistent) {
            this.project(pending.c, pending.patch);
            await this.pool.query(
              "UPDATE control_operations SET status='applied',finished_at=? WHERE operation_id=?",
              [Date.now(), id]
            );
          } else {
            await this.pool.query(
              "UPDATE control_operations SET status=?,finished_at=? WHERE operation_id=?",
              [
                pending.applied
                  ? this.recent.get(id)?.status || "uncertain"
                  : "uncertain",
                Date.now(),
                id,
              ]
            );
          }
        }
        this.unresolved.delete(id);
      }
      this.queue.resume();
    } catch {
      setTimeout(() => void this.reconcile(), 1000).unref();
    } finally {
      this.reconciling = false;
    }
  }
  applyEffect(c) {
    const { g, p } = this.target(c),
      b = c.payload;
    p.adminSession = true;
    if (c.type === "power") {
      p.powers[b.key] = b.value;
      if (b.key === "godlike") p.powers.god = p.powers.aura = b.value;
      p.applyPowers();
      g.refreshPlayerData(p);
    }
    if (c.type === "give") {
      const field = b.resource === "gold" ? "points" : b.resource;
      p[field] += b.amount;
      p.send("N", field, p[field], 1);
    }
    if (c.type === "teleport") {
      p.x = b.x;
      p.y = b.y;
      p.xVel = p.yVel = 0;
    }
    if (c.type === "spawn")
      g.ai_manager.spawn(p.x + p.scale + 200, p.y, 0, b.index, {
        despawnOnDeath: true,
      });
    if (c.type === "kick") {
      if (!p.kick) throw error("target_disconnected", 409);
      p.kick("Encerrado pelo dono");
    }
    this.emit("admin_action", {
      staff: true,
      server: g.key,
      accountId: p.account?.id,
      lifeId: p.lifeId,
      type: c.type,
      operationId: c.operationId,
    });
  }
  async start(games) {
    this.games = games;
    for (const g of games.values())
      g.mapSha256 = g.worldMap ? hash(g.worldMap) : "generated-default";
    if (!this.enabled) return;
    this.loop.enable();
    this.timers = [
      setInterval(
        () =>
          void this.pool
            .query("DELETE FROM control_telemetry WHERE at<? LIMIT 10000", [
              Date.now() - 7 * 86400000,
            ])
            .catch(() => {}),
        3600000
      ),
      setInterval(() => void this.flushEvents(), 2000),
      setInterval(() => {
        for (const g of this.games.values()) {
          const samples = (g.tickSamples || []).slice().sort((a, b) => a - b);
          if (samples.length)
            g.tickMetric = {
              count: samples.length,
              p50: samples[Math.floor(samples.length * 0.5)],
              p95: samples[Math.floor(samples.length * 0.95)],
              p99: samples[
                Math.min(samples.length - 1, Math.floor(samples.length * 0.99))
              ],
              interval: g.tickInterval,
            };
        }
        const snap = this.snapshot();
        this.emit("metric", {
          worlds: snap.worlds,
          queue: snap.queue,
          rss: process.memoryUsage().rss,
          eventLoopP99: this.loop.percentile(99) / 1e6,
        });
        this.loop.reset();
      }, 10000),
    ];
    this.timers.forEach(t => t.unref());
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      const token = Buffer.from(
          String(req.headers.authorization || "").replace(/^Bearer /, "")
        ),
        expected = Buffer.from(process.env.CONTROL_SECRET);
      if (token.length !== expected.length || !timingSafeEqual(token, expected))
        return res.status(403).json({ error: "forbidden" });
      res.set("Cache-Control", "no-store");
      next();
    });
    app.use(express.json({ limit: "4mb", strict: true }));
    app.get("/v1/status", (_req, res) => res.json(this.snapshot()));
    app.get("/v1/catalog", (_req, res) =>
      res.json({
        ...contract.catalog(),
        animals: AI_TYPES.map(a => ({
          id: a.id,
          name: a.name || a.src,
          src: a.src,
          scale: a.scale,
          killScore: a.killScore,
          drop: a.drop,
        })),
      })
    );
    app.get("/v1/players", (_req, res) => res.json(this.players()));
    app.get("/v1/accounts", (req, res) => {
      const q = String(req.query.q || "")
          .slice(0, 120)
          .toLowerCase(),
        offset = Math.max(0, Math.min(1000000, Number(req.query.offset) || 0));
      const rows = Object.values(this.accounts.data.accounts).filter(
        a =>
          (a.name || "").toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q)
      );
      res.json({
        total: rows.length,
        rows: rows
          .slice(offset, offset + 50)
          .map(a => ({
            ...safeAccount(a),
            fingerprint: accountFingerprint(a),
            revision: this.state.get("account:" + a.id)?.revision || 0,
            segment:
              this.state.get("account:" + a.id)?.payload?.segment ||
              a.segment ||
              "organic",
          })),
      });
    });
    app.get("/v1/world/:key", (req, res) => {
      const g = games.get(req.params.key);
      if (!g) return res.status(404).end();
      res.json({
        version: 1,
        width: 14400,
        height: 14400,
        objects: g.game_objects
          .filter(o => o.active && !o.owner)
          .map((o, i) => ({
            id: o.authoringId || "baseline-" + i,
            kind: o.isItem
              ? "building"
              : o.type === 0
                ? "tree"
                : o.type === 1
                  ? contract.biomeAt(o.y) === 2
                    ? "cactus"
                    : "bush"
                  : o.type === 2
                    ? "stone"
                    : "gold",
            item: o.id,
            x: o.x,
            y: o.y,
            scale: o.scale,
            dir: o.dir,
          })),
        encounters: configlessEncounters(g),
        spawns: g.worldMap?.spawns || [],
      });
    });
    app.get("/v1/operations/:id", async (req, res, next) => {
      try {
        const [rows] = await this.pool.query(
          "SELECT operation_id,type,actor,reason,target_json,status,result_json,created_at,finished_at FROM control_operations WHERE operation_id=?",
          [req.params.id]
        );
        if (!rows.length)
          return res.status(404).json({ error: "operation_missing" });
        res.json({
          ...rows[0],
          runtimeReceipt: this.recent.get(req.params.id) || null,
        });
      } catch (e) {
        next(e);
      }
    });
    app.get("/v1/audit", async (req, res, next) => {
      try {
        const before = Number(req.query.before) || Date.now() + 1;
        const [rows] = await this.pool.query(
          {
            sql: "SELECT operation_id,type,actor,reason,target_json,status,result_json,created_at FROM control_operations WHERE created_at<? ORDER BY created_at DESC LIMIT 50",
            timeout: 2000,
          },
          [before]
        );
        res.json(rows);
      } catch (e) {
        next(e);
      }
    });
    app.get("/v1/telemetry", async (req, res, next) => {
      try {
        const after = Math.max(0, Number(req.query.after) || 0);
        const [rows] = await this.pool.query(
          {
            sql: "SELECT seq,event_id,at,kind,payload FROM control_telemetry WHERE seq>? ORDER BY seq LIMIT 500",
            timeout: 2000,
          },
          [after]
        );
        const [[first]] = await this.pool.query(
          "SELECT MIN(seq) AS oldest FROM control_telemetry"
        );
        res.json({
          rows,
          oldestSeq: Number(first.oldest) || 0,
          collectionStartedAt: this.startedAt,
        });
      } catch (e) {
        next(e);
      }
    });
    app.post("/v1/maps/validate", (req, res) =>
      res.json(contract.validateMap(req.body))
    );
    app.post("/v1/commands", async (req, res, next) => {
      try {
        res.json(await this.execute(req.body));
      } catch (e) {
        next(e);
      }
    });
    app.use((e, _req, res, _next) => {
      if (!e.status) this.log("control: request failed");
      res
        .status(e.status || 503)
        .json({ error: e.status ? e.message : "dependency_unavailable" });
    });
    const socket = process.env.CONTROL_SOCKET;
    fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o750 });
    if (fs.existsSync(socket)) {
      if (!fs.lstatSync(socket).isSocket())
        throw error("control_socket_not_socket");
      fs.unlinkSync(socket);
    }
    this.http = createServer(app);
    await new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(socket, () => {
        fs.chmodSync(socket, 0o660);
        resolve();
      });
    });
  }
  async close() {
    this.timers?.forEach(clearInterval);
    this.loop.disable();
    this.http?.close();
    await this.flushEvents();
  }
}
function configlessEncounters(g) {
  return g.ais
    .filter(a => a.active && [0, 1, 2, 3, 4, 5, 9, 10, 12].includes(a.index))
    .map((a, i) => ({ id: "animal-" + i, index: a.index, x: a.x, y: a.y }));
}
