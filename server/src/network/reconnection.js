// RECONNECTION
// A dropped WebSocket is not a departed player. For a short, explicit grace period
// (GRACE_MS) the player stays in its world — same sid, position, resources, items and
// buildings — frozen, so a link drop is never an advantage:
//   * no input acts while there is no socket (movement, gathering and building state
//     are cleared by Game.suspendPlayer, and the protocol session that accepted input
//     is gone with the socket);
//   * no protection is granted either: the player stays visible, targetable and fully
//     damageable, and can die while away (a resume after death is a normal new life).
//
// A new connection resumes that player only when it proves the same identity the
// authoritative way: a FRESH join ticket (POST /join, single use, bound to this
// server) whose account — or, for guests, the server-issued device id — matches a
// player of THIS game server. The resume attaches a brand new ProtocolSession to the
// very same Player object; nothing is copied and nothing is duplicated. When the
// grace period expires without a resume, the player leaves through the normal
// removal path (Game.removePlayer: life recorded, tribe left, buildings torn down,
// "E" broadcast) — the suspension only delays that reference removal.
//
// Kicks, bans and server shutdown are final: a kicked player (which is everyone at
// shutdown, via Game.closeAll) is never suspended, a kick landing during a
// suspension cancels it, and a banned identity never passes the connection gate to
// reach this manager.
//
// Logs never include tickets, device ids or session keys — sids and names only.

export const GRACE_MS = 30 * 1000;

export class ReconnectionManager {

    constructor({ graceMs = GRACE_MS, log = () => {} } = {}) {
        this.graceMs = graceMs;
        this.log = log;
        this.pending = new Map();   // key -> { player, game, timer, expiresAt }
    }

    // The resume identity: the account first, then the device id a guest got with its
    // ticket. Scoped to the game server: a ticket for LC can never resume an MB player.
    keyFor(game, account, did) {
        const id = account ? `acc:${account.id}` : did ? `did:${did}` : null;
        return id ? `${game.key}|${id}` : null;
    }

    // Keep a disconnected player in its world for the grace period. Returns false when
    // the player must leave right away (never spawned, kicked, or — without tickets —
    // no identity a future connection could prove).
    suspend(game, player) {
        if (!player.spawned || player.kicked) return false;
        const key = this.keyFor(game, player.account, player.did);
        if (!key) return false;
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing.timer);
        game.suspendPlayer(player);
        const timer = setTimeout(() => {
            this.pending.delete(key);
            this.log(`[${game.key}] resume expired for sid ${player.sid} (${player.name})`);
            game.removePlayer(player);
        }, this.graceMs);
        if (timer.unref) timer.unref();
        this.pending.set(key, { player, game, timer, expiresAt: Date.now() + this.graceMs });
        return true;
    }

    // Who may this new connection resume as? { key, player, takeover } or null.
    // A suspended player matches by identity; a still-connected player with the same
    // identity (a second tab, or the old socket's close event not having reached us
    // yet) is taken over — never duplicated. A suspension whose player was kicked
    // meanwhile is dropped instead.
    match(game, account, did) {
        const key = this.keyFor(game, account, did);
        if (!key) return null;
        const entry = this.pending.get(key);
        if (entry) {
            if (entry.player.kicked) {
                this.clear(key);
                return null;
            }
            return { key, player: entry.player, takeover: false };
        }
        const live = game.players.find(p => !p.kicked && (account
            ? p.account && p.account.id === account.id
            : p.did && p.did === did));
        return live ? { key, player: live, takeover: true } : null;
    }

    // The resume is happening: stop the expiry clock.
    claim(match) {
        this.clear(match.key);
    }

    clear(key) {
        const entry = this.pending.get(key);
        if (entry) clearTimeout(entry.timer);
        this.pending.delete(key);
    }

    // Introspection (tests / admin): the players currently inside the grace period.
    pendingFor(game) {
        return [...this.pending.values()].filter(e => e.game === game).map(e => e.player);
    }
}
