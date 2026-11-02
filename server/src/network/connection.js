// CONNECTION
// Lifecycle of one WebSocket:
//   1. gate      origin, build id (?b=), bundle (?u=), join ticket (?token=tk:...), bans, members-only
//   2. io-init   protocol handshake (session seed, key, keyed + pinned mode, seal mode)
//   3. frames    decode (tag / sequence / table) -> anticheat rate limit -> packet handler
//   4. close     grace-period suspension (reconnection.js) or cleanup
//
// Reconnection: a dropped socket suspends its player for a short grace period instead
// of removing it (reconnection.js). A new connection carrying a fresh ticket for the
// same account / device on the same game server resumes that very player — with a new
// ProtocolSession created here like any other connection.

import { randomBytes } from "node:crypto";
import { ProtocolSession } from "../protocol/session.js";
import { CLOSE } from "../protocol/constants.js";
import { sealValue } from "../protocol/crypto.js";
import { AntiCheat, ANTICHEAT_CONFIG } from "../anticheat/index.js";
import { ConnectionLimit } from "../moomoo/libs/limit.js";
import { handlePacket } from "./packets.js";
import { ReconnectionManager, GRACE_MS } from "./reconnection.js";

const DEBUG_PACKETS = Boolean(process.env.DEBUG_PACKETS);

export function createConnectionHandler({ build, bundle, accounts, moderation, log, chat, graceMs = GRACE_MS }) {
    const limiter = new ConnectionLimit(ANTICHEAT_CONFIG.connection.maxConnectionsPerIp);
    const rules = ANTICHEAT_CONFIG.connection;
    const reconnection = new ReconnectionManager({ graceMs, log });

    return function onConnection(ws, req, game) {
        const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
        const url = new URL(req.url, "http://localhost");
        const reject = (code, why) => {
            log(`[${game.key}] rejected ${ip}: ${why}`);
            try {
                ws.close(code);
            } catch {}
        };

        // ---- 1. gate ----
        if (rules.enforceOrigin) {
            let originHost = null;
            try {
                originHost = new URL(req.headers.origin).host;
            } catch {}
            if (originHost !== req.headers.host) return reject(CLOSE.WRONG_ORIGIN, `origin ${req.headers.origin}`);
        }
        if (rules.enforceBuild && url.searchParams.get("b") !== build.BUILD_ID) {
            return reject(CLOSE.GAME_UPDATED, `build ${url.searchParams.get("b")} != ${build.BUILD_ID}`);
        }
        // ?u= is the bundle file the page is running ([Lx]).
        const served = bundle ? bundle.current() : null;
        const stem = url.searchParams.get("u") || "";
        if (rules.enforceBundle && served && stem !== served.stem) {
            return reject(CLOSE.GAME_UPDATED, `bundle ${stem || "?"} != ${served.stem}`);
        }
        if (limiter.check(ip)) return reject(CLOSE.INVALID_CONNECTION, "too many connections from this ip");

        let account = null;
        let did = null;
        if (rules.requireTicket) {
            const token = url.searchParams.get("token") || "";
            const ticket = token.startsWith("tk:") ? accounts.consumeTicket(token.slice(3), rules.ticketMaxAgeMs) : null;
            if (!ticket) return reject(CLOSE.INVALID_CONNECTION, "missing or invalid join ticket");
            if (ticket.server && ticket.server !== game.key) return reject(CLOSE.INVALID_CONNECTION, `ticket is for server ${ticket.server}`);
            account = ticket.account;
            did = ticket.did;
        }
        if (moderation.isBanned(ip, account && account.id, did) || (account && account.verdict === "ban")) {
            return reject(CLOSE.INVALID_CONNECTION, "banned");
        }
        if (game.membersOnly && !account) return reject(CLOSE.SIGN_IN_REQUIRED, "members-only server");

        limiter.up(ip);

        // ---- 2. handshake ----
        const socketId = randomBytes(8).toString("hex");
        const seal = served && stem === served.stem ? { mode: ANTICHEAT_CONFIG.seal.mode, value: sealValue(build.sealBytes, served.digest) } : null;
        const session = new ProtocolSession(build, socketId, { seal });
        ws.send(session.handshakeFrame());

        let closed = false;
        const send = (type, ...args) => {
            if (closed || ws.readyState !== ws.OPEN || !session.canSend(type)) return;
            ws.send(session.encode(type, args));
        };

        const staff = account && (account.role === "admin" || account.role === "mod");

        // RECONNECT: a fresh ticket for an identity that still has a player in this
        // world takes that player over (same object, sid, position, resources and
        // buildings) instead of adding a second one. A resumed player already holds a
        // slot, so the capacity check only applies to genuinely new players.
        const resume = reconnection.match(game, account, did);
        let player;
        if (resume) {
            reconnection.claim(resume);
            player = resume.player;
            // Takeover (the old close event hasn't landed yet, or a second tab): the
            // old socket is retired; its handlers go inert via the player.conn check.
            const stale = player.conn;
            player.conn = null;
            if (stale && stale.ws) {
                try { stale.ws.close(); } catch {}
            }
            game.rejoinPlayer(player, { send, ip });
            player.did = did;
        } else {
            if (game.playerCount() >= game.capacity && !staff) {
                send("B", "server is full");
                setTimeout(() => ws.close(), 100);
                limiter.down(ip);
                closed = true;
                return;
            }
            player = game.addPlayer({ send, account, ip, id: socketId });
            if (!player) {
                send("B", "server is full");
                setTimeout(() => ws.close(), 100);
                limiter.down(ip);
                closed = true;
                return;
            }
            player.did = did;
        }
        if (account) {
            account.lastSeen = { ip, did, at: Date.now(), server: game.key };
            accounts.save();
        }
        // The connection that currently owns the player. A stale socket (retired by a
        // takeover) notices player.conn !== conn and stops touching the player.
        const conn = { ws };
        player.conn = conn;
        player.kick = (reason) => {
            player.kicked = true;   // kicks — and shutdown, via Game.closeAll — are final: never suspended, never resumed
            send("B", reason);
            setTimeout(() => ws.close(), 100);
        };
        const previousAc = resume ? player.anticheat : null;
        player.anticheat = new AntiCheat({
            player,
            store: moderation,
            session,
            sendProbes: (salt, probes) => send("q", salt, probes),
            log: (msg) => log(`[${game.key}] ${player.name}#${player.sid} (${ip}): ${msg}`),
            kick: (reason) => player.kick(reason),
            close: (code) => ws.close(code)
        });
        if (previousAc) {
            // Strikes and flags survive a reconnect: dropping the socket is not a reset.
            player.anticheat.strikes = previousAc.strikes;
            player.anticheat.strikeTime = previousAc.strikeTime;
            player.anticheat.flags = previousAc.flags;
            player.anticheat.flagNames = new Set(previousAc.flagNames);
            player.anticheat.untrustedEvents = previousAc.untrustedEvents;
        }

        const ctx = { game, accounts, moderation, log, chat };
        log(`[${game.key}] ${resume ? "resume" : "join"} sid ${player.sid} (${account ? "account " + (account.name || account.email) : "guest"}, ${ip})`);

        // ---- 3. frames ----
        ws.on("message", (data) => {
            if (closed || player.conn !== conn) return;   // retired by a takeover
            const frame = data instanceof Buffer ? data : Buffer.from(data);
            const msg = session.decode(frame);
            if (msg.error) {
                // In seal "bind" mode a modified client fails right here, on its first frame.
                const sealHint = msg.error === "bad tag" && session.lastSeq === 0 && session.sealMode === 2 ? "seal mismatch: modified client or bundle" : msg.detail;
                player.anticheat.onTransportError(msg.error, sealHint);
                return;
            }
            if (DEBUG_PACKETS && msg.name !== "0") log(`[${game.key}] <- ${msg.name} ${JSON.stringify(msg.args).slice(0, 120)}`);
            if (!player.anticheat.allow(msg.name)) return;
            try {
                handlePacket(ctx, player, msg.name, msg.args);
            } catch (error) {
                log(`[${game.key}] error in packet "${msg.name}": ${error.stack || error}`);
                player.anticheat.invalid(msg.name, "handler exception");
            }
        });

        // ---- 4. close ----
        ws.on("close", () => {
            if (closed) return;
            closed = true;
            limiter.down(ip);
            if (player.conn !== conn) return;   // another socket already owns the player
            player.conn = null;
            if (reconnection.suspend(game, player)) {
                log(`[${game.key}] link lost sid ${player.sid} (${player.name}); resumable for ${Math.round(reconnection.graceMs / 1000)}s`);
                return;
            }
            log(`[${game.key}] leave sid ${player.sid} (${player.name})`);
            game.removePlayer(player);
        });
        ws.on("error", () => {});
    };
}
