// ANTICHEAT CONFIG
// NOTE (integration): this file was missing from the clone copy and was reconstructed
// from the documented behaviour (README "Anti-cheat" section: probe cadence, flag actions,
// rejoin locks, 40-strikes kick, 30 s Shame! hat) and the call sites in
// anticheat/index.js, network/connection.js, network/packets.js, api/routes.js and
// admin/console.js. Gameplay rules are untouched; these are server-side guardrails only.
//
// Actions a check can take (AntiCheat.apply):
//   "close"  close the socket (4001 Invalid Connection)
//   "kick"   kick + rejoin lock of kickLock.anticheatSeconds
//   "shame"  30 s Shame! hat
//   "flag"   log it, remember it on the account (staff panel), no disconnect

export const ANTICHEAT_CONFIG = {

    // ModerationStore files, inside DATA_DIR.
    storage: {
        reports: "reports.jsonl",
        bans: "bans.json"
    },

    // WebSocket gate (network/connection.js).
    connection: {
        maxConnectionsPerIp: 10,
        enforceOrigin: true,   // foreign Origin -> close 4004
        enforceBuild: true,    // ?b= must be the current BUILD_ID -> close 4002
        enforceBundle: true,   // ?u= must be the bundle this server serves -> close 4002
        requireTicket: true,   // ?token=tk:... from POST /api/join -> close 4001
        ticketMaxAgeMs: 60000
    },

    // Code seal. Mode 2 (default): the seal is mixed into the frame key, so a modified
    // client fails on its first frame. Mode 1 only reports a hash in "T"; a mismatch
    // there takes mismatchAction.
    seal: {
        mode: 2,
        mismatchAction: "flag"
    },

    // Rejoin lock after a kick (ModerationStore.lock).
    kickLock: {
        anticheatSeconds: 60,   // kicked by the anti-cheat
        staffSeconds: 120       // kicked by staff ("try again in 2 minutes")
    },

    // Shame! (auto-heal detection, original game logic): shame hat duration.
    shame: {
        durationMs: 30000
    },

    // Transport errors (bad tag / replayed seq / unknown id / malformed frame).
    transport: {
        badTag: "close",
        badSequence: "close",
        unknownPacket: "close",
        malformed: "close"
    },

    // Argument validation: strikes per invalid packet.
    validation: {
        strikesPerInvalid: 2
    },

    // Token buckets [perSecond, burst]. `global` covers every packet; `packets` adds a
    // per-packet bucket (names are the client->server packet ids). Exceeding a bucket
    // drops the packet and adds a strike; strikesToKick strikes (decaying one per
    // strikeDecayMs) kick the player.
    rateLimits: {
        global: [120, 240],
        strikeDecayMs: 1000,
        strikesToKick: 40,
        // anonymous mode toggle: at most once per 31 s (packets.js "I")
        anonCooldownMs: 31000,
        packets: {
            "M": [1, 2],        // spawn
            "D": [20, 40],      // aim direction
            "9": [10, 20],      // move direction
            "e": [5, 10],       // reset movement
            "F": [15, 30],      // mouse down/up
            "z": [10, 20],      // select item / weapon
            "H": [5, 10],       // upgrade pick
            "K": [5, 10],       // lock rotation / auto-gather
            "L": [2, 4],        // create tribe
            "N": [2, 4],        // leave tribe
            "b": [2, 4],        // request to join tribe
            "P": [5, 10],       // answer join request
            "Q": [2, 4],        // kick tribe member
            "c": [5, 10],       // store buy / equip
            "6": [1, 3],        // chat
            "S": [1, 3],        // map ping
            "0": [1, 3],        // ping
            "T": [1, 2],        // telemetry (only in answer to "q")
            "R": [1, 3],        // report
            "A": [5, 10],       // admin command
            "V": [2, 5],        // profile / live stats
            "I": [1, 2]         // anonymous mode (also anonCooldownMs)
        }
    },

    // Server-driven telemetry: "q" probe rounds, answered by the client with "T".
    telemetry: {
        required: true,
        firstProbeMs: 5000,     // first round 5 s after spawning
        intervalMs: 60000,      // then every 60 s
        answerMs: 45000,        // no answer within 45 s -> missingAction
        missingAction: "kick",
        // Bits of the flags field of "T" (set by the client's own checks).
        flags: {
            1: { name: "USERSCRIPT_MANAGER", action: "flag" },
            2: { name: "SOCKET_HOOKED", action: "kick" },
            4: { name: "RENDER_HOOKED", action: "flag" },
            8: { name: "DEBUGGER_PAUSED", action: "flag" },
            16: { name: "SOCKET_INTEGRITY", action: "kick" },
            32: { name: "SOCKET_OWN_PROPS", action: "flag" }
        },
        // Script-dispatched (untrusted) input events the client counted.
        untrustedEvents: {
            threshold: 20,
            action: "flag"
        },
        // "T" also reports the client's send sequence and its rolling FNV-1a hash of the
        // c2s frames; they must match the server's view of the same stream.
        ledger: {
            mismatchAction: "flag"
        }
    },

    // Integrity probes sent in "q" as [kind, path, hash]. Each round picks `perRound`
    // of these in a shuffled order with a fresh salt; kinds 1-4, 6 and 8 are compared as
    // salted hashes so a script can't see what's being looked for. Probe kinds:
    //   1 own property names of the object at `path`   (value: the name to look for)
    //   2 "name=value" of the plain properties at `path`
    //   3 localStorage keys                            (value: the key to look for)
    //   4 elements as "tag#id"                         (value: the id to look for)
    //   5 constructor at `path` swapped for a wrapper
    //   6 symbol descriptions                          (value: the description to look for)
    //   7 function at `path` that isn't native code
    //   8 elements as "tag.class"                      (value: the class to look for)
    //   9 CustomEvent named `path` (clear) resolves through a listener
    // A matched probe takes the rule's action (default "flag": logged, staff panel only).
    probes: {
        perRound: 30,
        list: [
            // userscript managers / well-known userscript globals on window
            { kind: 1, path: "window", value: "GM_info", name: "GM_INFO", action: "flag" },
            { kind: 1, path: "window", value: "GM_xmlhttpRequest", name: "GM_XHR", action: "flag" },
            { kind: 1, path: "window", value: "unsafeWindow", name: "UNSAFE_WINDOW", action: "flag" },
            { kind: 1, path: "window", value: "GM", name: "GM", action: "flag" },
            // tampering with the transport / render primitives
            { kind: 5, path: "window.WebSocket", name: "WS_CONSTRUCTOR_WRAPPED", action: "flag" },
            { kind: 7, path: "window.WebSocket.prototype.send", name: "WS_SEND_NOT_NATIVE", action: "flag" },
            { kind: 7, path: "window.requestAnimationFrame", name: "RAF_NOT_NATIVE", action: "flag" },
            { kind: 7, path: "window.HTMLCanvasElement.prototype.getContext", name: "GET_CONTEXT_NOT_NATIVE", action: "flag" },
            { kind: 7, path: "window.Function.prototype.toString", name: "TOSTRING_NOT_NATIVE", action: "flag" }
        ]
    }
};
