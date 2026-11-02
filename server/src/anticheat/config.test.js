// ANTICHEAT CONFIG TEST
// config.js was reconstructed during the Jagunco.io integration (it was missing from the
// clone copy). These tests pin the shape that anticheat/index.js, network/connection.js,
// network/packets.js, api/routes.js and admin/console.js rely on, so a bad edit fails
// here instead of at runtime.

import test from "node:test";
import assert from "node:assert/strict";
import { ANTICHEAT_CONFIG as CONFIG } from "./config.js";

const ACTIONS = new Set(["close", "kick", "shame", "flag"]);
const isBucket = (v) => Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n > 0);

test("storage file names", () => {
    assert.equal(typeof CONFIG.storage.reports, "string");
    assert.equal(typeof CONFIG.storage.bans, "string");
});

test("connection gate options", () => {
    const c = CONFIG.connection;
    assert.ok(Number.isInteger(c.maxConnectionsPerIp) && c.maxConnectionsPerIp > 0);
    for (const flag of ["enforceOrigin", "enforceBuild", "enforceBundle", "requireTicket"]) {
        assert.equal(typeof c[flag], "boolean", flag);
    }
    assert.ok(Number.isFinite(c.ticketMaxAgeMs) && c.ticketMaxAgeMs > 0);
});

test("seal mode and mismatch action", () => {
    assert.ok([0, 1, 2].includes(CONFIG.seal.mode));
    assert.ok(ACTIONS.has(CONFIG.seal.mismatchAction));
});

test("kick locks and shame duration", () => {
    assert.ok(CONFIG.kickLock.anticheatSeconds > 0);
    assert.ok(CONFIG.kickLock.staffSeconds > 0);
    assert.ok(CONFIG.shame.durationMs > 0);
});

test("transport error actions", () => {
    for (const key of ["badTag", "badSequence", "unknownPacket", "malformed"]) {
        assert.ok(ACTIONS.has(CONFIG.transport[key]), key);
    }
});

test("rate limits are [perSecond, burst] buckets", () => {
    assert.ok(isBucket(CONFIG.rateLimits.global), "global");
    assert.ok(CONFIG.rateLimits.strikeDecayMs > 0);
    assert.ok(CONFIG.rateLimits.strikesToKick > 0);
    assert.ok(CONFIG.rateLimits.anonCooldownMs > 0);
    assert.ok(Object.keys(CONFIG.rateLimits.packets).length > 0);
    for (const [name, bucket] of Object.entries(CONFIG.rateLimits.packets)) {
        assert.ok(isBucket(bucket), `packet "${name}"`);
    }
});

test("validation strikes", () => {
    assert.ok(CONFIG.validation.strikesPerInvalid > 0);
});

test("telemetry schedule and actions", () => {
    const t = CONFIG.telemetry;
    assert.equal(typeof t.required, "boolean");
    assert.ok(t.firstProbeMs > 0 && t.intervalMs > 0 && t.answerMs > 0);
    assert.ok(ACTIONS.has(t.missingAction));
    assert.ok(ACTIONS.has(t.untrustedEvents.action));
    assert.ok(t.untrustedEvents.threshold > 0);
    assert.ok(ACTIONS.has(t.ledger.mismatchAction));
    // flag bits fit in the client's 8-bit flags field
    for (const [bit, rule] of Object.entries(t.flags)) {
        const b = Number(bit);
        assert.ok(Number.isInteger(b) && b > 0 && b <= 128 && (b & (b - 1)) === 0, `bit ${bit} is a single 8-bit flag`);
        assert.equal(typeof rule.name, "string");
        assert.ok(ACTIONS.has(rule.action), rule.name);
    }
});

test("probe list: valid kinds, names and actions, perRound within the client cap", () => {
    const { list, perRound } = CONFIG.probes;
    assert.ok(Array.isArray(list) && list.length > 0);
    assert.ok(Number.isInteger(perRound) && perRound > 0 && perRound <= 30);
    for (const rule of list) {
        assert.ok(Number.isInteger(rule.kind) && rule.kind >= 1 && rule.kind <= 9, `kind ${rule.kind}`);
        assert.equal(typeof rule.name, "string");
        assert.ok(ACTIONS.has(rule.action), rule.name);
        if (rule.kind === 9) assert.equal(typeof rule.path, "string", "kind 9 carries the event name in clear");
    }
});
