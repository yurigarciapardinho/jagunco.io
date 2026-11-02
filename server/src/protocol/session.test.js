// TRANSPORT PROTOCOL (ProtocolSession + real crypto, pinned build fixtures on disk-tmp)
// Acceptance coverage (briefing §7, §11 item 17): tampered, replayed, out-of-order,
// malformed and unknown frames are all rejected with the right error class; valid frames
// round-trip through mask + tag; the seal binds the session key to the served bundle.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import msgpack from "msgpack-lite";
import { ProtocolSession, DECODE_ERROR } from "./session.js";
import { createProtocolBuild } from "./build.js";
import { hmacTag, xorMask, c2sMaskSeed, s2cMaskSeed, deriveMaskSeeds, hexToBytes } from "./crypto.js";
import { SEAL_BIND } from "./constants.js";

const { encode, decode } = msgpack;

// Build a client frame exactly as the real client transport does:
// tag = HMAC(key, plaintextBody); frame = tag || mask(plaintext, c2sSeed ^ u32(tag)).
function craftFrame(build, session, name, args, seq, { key = session.key, mask = session.mask } = {}) {
    const id = session.tables.c2s.enc[name];
    assert.notEqual(id, undefined, `packet "${name}" exists in the c2s table`);
    const body = new Uint8Array(encode([id, args, seq]));
    const tag = hmacTag(key, body);
    const masked = new Uint8Array(body);
    if (mask) xorMask(masked, c2sMaskSeed(mask.c2s, tag));
    const frame = new Uint8Array(tag.length + masked.length);
    frame.set(tag, 0);
    frame.set(masked, tag.length);
    return frame;
}

let cachedBuild = null;
async function getBuild(t) {
    if (!cachedBuild) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-proto-"));
        cachedBuild = await createProtocolBuild({ outDir: tmp, pinFile: path.join(tmp, "pin.json") });
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    }
    return cachedBuild;
}

test("handshake frame carries socketId, seed, raw key and modes in plain msgpack", async (t) => {
    const build = await getBuild(t);
    const session = new ProtocolSession(build, "sock-1", { pinned: true });
    const frame = decode(session.handshakeFrame());
    assert.equal(frame[0], "io-init");
    const [socketId, seed, keyHex, mode, pinned, sealMode] = frame[1];
    assert.equal(socketId, "sock-1");
    assert.equal(seed, session.seed);
    assert.equal(hexToBytes(keyHex).length, 16, "16-byte raw key");
    assert.equal(pinned, 1);
    assert.equal(sealMode, 0, "no seal requested -> SEAL_OFF");
});

test("pinned session: valid frames decode, ledger advances, s2c masks round-trip", async (t) => {
    const build = await getBuild(t);
    const session = new ProtocolSession(build, "s", { pinned: true });

    const f1 = craftFrame(build, session, "D", [1.5], 1);
    const m1 = session.decode(f1);
    assert.deepEqual(m1, { name: "D", args: [1.5], seq: 1 }, "first frame decodes");
    assert.notEqual(session.ledger, session.ledgerBefore, "ledger folded the frame");

    const f2 = craftFrame(build, session, "9", [null], 2);
    assert.equal(session.decode(f2).name, "9", "sequence continues");

    // s2c: masked with the counter keystream; unmasking must recover the exact payload
    const out = session.encode("D", [2.5]);
    const plain = new Uint8Array(out);
    xorMask(plain, s2cMaskSeed(session.mask.s2c, session.sent));
    const [id, args] = decode(plain);
    assert.equal(session.tables.s2c.dec[id], "D", "masked s2c recovers the packet id");
    assert.deepEqual(args, [2.5]);
    assert.equal(session.canSend("M"), true);
    assert.equal(session.canSend("NOT_A_PACKET"), false);
    assert.throws(() => session.encode("NOT_A_PACKET", []), /not in this session/, "unknown s2c names throw");
});

test("replayed, gapped, tampered, truncated and malformed frames are rejected", async (t) => {
    const build = await getBuild(t);
    const session = new ProtocolSession(build, "s", { pinned: true });

    const good = craftFrame(build, session, "D", [0], 1);
    assert.equal(session.decode(good).seq, 1);

    assert.equal(session.decode(good).error, DECODE_ERROR.BAD_SEQUENCE, "replay rejected");
    const gap = craftFrame(build, session, "D", [0], 3);
    const r = session.decode(gap);
    assert.equal(r.error, DECODE_ERROR.BAD_SEQUENCE, "gap rejected");
    assert.match(r.detail, /expected 2, got 3/);

    const tampered = craftFrame(build, session, "D", [0], 2);
    tampered[tampered.length - 1] ^= 0xff; // flip a body byte: tag no longer matches
    assert.equal(session.decode(tampered).error, DECODE_ERROR.BAD_TAG, "tampered body rejected");

    assert.equal(session.decode(new Uint8Array([1, 2, 3])).error, DECODE_ERROR.SHORT_FRAME, "truncated frame");

    // a correctly tagged frame of garbage: msgpack decode fails -> MALFORMED
    const garbage = new Uint8Array([0xc1, 0xc1, 0xc1]);
    const gtag = hmacTag(session.key, garbage);
    const gframe = new Uint8Array(6 + garbage.length);
    gframe.set(gtag, 0);
    const gmasked = new Uint8Array(garbage);
    xorMask(gmasked, c2sMaskSeed(session.mask.c2s, gtag));
    gframe.set(gmasked, 6);
    assert.equal(session.decode(gframe).error, DECODE_ERROR.MALFORMED, "tagged garbage rejected");

    // unknown packet id with a valid tag
    const unknown = new Uint8Array(encode([222, [], 2]));
    const utag = hmacTag(session.key, unknown);
    const uframe = new Uint8Array(6 + unknown.length);
    uframe.set(utag, 0);
    const umasked = new Uint8Array(unknown);
    xorMask(umasked, c2sMaskSeed(session.mask.c2s, utag));
    uframe.set(umasked, 6);
    assert.equal(session.decode(uframe).error, DECODE_ERROR.UNKNOWN_PACKET, "unknown id rejected");

    // args not an array
    const badArgs = new Uint8Array(encode([session.tables.c2s.enc["D"], "nope", 3]));
    const btag = hmacTag(session.key, badArgs);
    const bframe = new Uint8Array(6 + badArgs.length);
    bframe.set(btag, 0);
    const bmasked = new Uint8Array(badArgs);
    xorMask(bmasked, c2sMaskSeed(session.mask.c2s, btag));
    bframe.set(bmasked, 6);
    assert.equal(session.decode(bframe).error, DECODE_ERROR.BAD_ARGS, "non-array args rejected");
});

test("legacy (unpinned) sessions still authenticate and sequence frames", async (t) => {
    const build = await getBuild(t);
    const session = new ProtocolSession(build, "s", { pinned: false });
    assert.equal(session.mask, null, "legacy frames are unmasked");

    const frame = craftFrame(build, session, "D", [3], 1);
    assert.equal(session.decode(frame).name, "D", "legacy frame decodes");
    const tampered = craftFrame(build, session, "D", [4], 2);
    tampered[6] ^= 1;
    assert.equal(session.decode(tampered).error, DECODE_ERROR.BAD_TAG, "legacy frames are still HMAC'd");
});

test("seal mode 2: a client without the seal fails on its first frame", async (t) => {
    const build = await getBuild(t);
    const seal = { mode: SEAL_BIND, value: new Uint8Array(16).fill(7) };
    const session = new ProtocolSession(build, "s", { pinned: true, seal });
    assert.equal(session.sealMode, SEAL_BIND);

    // correct key (rawKey mixed with the build mixer, then XORed with the seal) works
    const good = craftFrame(build, session, "D", [0], 1);
    assert.equal(session.decode(good).seq, 1, "sealed client connects");

    // a tampered-bundle client derives the unsealed key and mask: BAD_TAG on frame one
    const session2 = new ProtocolSession(build, "s2", { pinned: true, seal });
    const wrongKey = build.mixKey(session2.rawKey, session2.seed); // no seal XOR
    const wrongMask = deriveMaskSeeds(wrongKey);
    const bad = craftFrame(build, session2, "D", [0], 1, { key: wrongKey, mask: wrongMask });
    assert.equal(session2.decode(bad).error, DECODE_ERROR.BAD_TAG, "modified bundle cannot connect");
});

test("pinned build: the pin file makes regeneration deterministic", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-pin-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const pinFile = path.join(tmp, "pin.json");
    const b1 = await createProtocolBuild({ outDir: path.join(tmp, "a"), pinFile });
    const b2 = await createProtocolBuild({ outDir: path.join(tmp, "b"), pinFile });
    assert.equal(b1.BUILD_ID, b2.BUILD_ID, "pinned build id is stable");
    assert.equal(b1.BUILD_SALT, b2.BUILD_SALT, "pinned salt is stable");
});
