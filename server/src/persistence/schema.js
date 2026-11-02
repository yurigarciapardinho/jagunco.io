// PERSISTENCE SCHEMA (Drizzle mysql-core)
// Relational layout for everything that must survive a restart in production:
// accounts (+prefs/socials/stats), clans (+members/invites/requests/past), friends,
// chat history, moderation (bans, reports, flags, verdicts). JSON columns are used
// only for genuinely free-form blobs (look / unlocks / report payload snapshots);
// anything with a known shape gets real columns and types.
//
// Counter columns are BIGINT (playtime is ms, damage/gold grow unbounded). `by` and
// `system` are reserved words in MySQL 8, so those columns are banned_by / is_system.

import { mysqlTable, char, varchar, bigint, int, boolean, json, primaryKey, uniqueIndex, index } from "drizzle-orm/mysql-core";

const id = () => char("id", { length: 24 });
const accountId = (name = "account_id") => char(name, { length: 24 });
const bigCounter = (name) => bigint(name, { mode: "number" }).notNull().default(0);

// ---------------------------------------------------------------- accounts
export const accounts = mysqlTable("accounts", {
    id: id().primaryKey(),
    email: varchar("email", { length: 120 }).notNull(),
    name: varchar("name", { length: 15 }),
    role: varchar("role", { length: 8 }),                       // null | admin | mod
    clan: varchar("clan", { length: 4 }),
    verdict: varchar("verdict", { length: 16 }),                // null | shadow | ban
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    look: json("look_json"),                                    // picked outfit (flexible blob)
    bestLook: json("best_look_json"),                           // outfit of the best life
    unlocks: json("unlocks_json"),                              // earned hats/accs/weapon variants
    discordName: varchar("discord_name", { length: 32 }),
    discordLinkedAt: bigint("discord_linked_at", { mode: "number" }),
    // Opaque scrypt credential string produced by api/passwords.js (format owned there).
    passwordCredential: varchar("password_credential", { length: 512 })
}, (t) => [
    uniqueIndex("uq_accounts_email").on(t.email),
    uniqueIndex("uq_accounts_name").on(t.name)
]);

export const accountPrefs = mysqlTable("account_prefs", {
    accountId: accountId().primaryKey(),
    friendNotifs: boolean("friend_notifs").notNull().default(true),
    friendRequests: boolean("friend_requests").notNull().default(true),
    clanInvites: boolean("clan_invites").notNull().default(true),
    clanChat: boolean("clan_chat").notNull().default(true),
    whispers: boolean("whispers").notNull().default(true)
});

export const accountSocials = mysqlTable("account_socials", {
    accountId: accountId().primaryKey(),
    youtube: varchar("youtube", { length: 32 }),
    twitch: varchar("twitch", { length: 32 }),
    tiktok: varchar("tiktok", { length: 32 }),
    x: varchar("x", { length: 32 }),
    discord: varchar("discord", { length: 32 })
});

export const accountStats = mysqlTable("account_stats", {
    accountId: accountId().primaryKey(),
    kills: bigCounter("kills"),
    deaths: bigCounter("deaths"),
    damage: bigCounter("damage"),
    healing: bigCounter("healing"),
    wood: bigCounter("wood"),
    food: bigCounter("food"),
    stone: bigCounter("stone"),
    gold: bigCounter("gold"),
    animalDamage: bigCounter("animal_damage"),
    bestScore: bigCounter("best_score"),
    maxKills: bigCounter("max_kills"),
    lives: bigCounter("lives"),
    playtime: bigCounter("playtime")
});

export const accountAnimalKills = mysqlTable("account_animal_kills", {
    accountId: accountId().notNull(),
    animal: varchar("animal", { length: 32 }).notNull(),
    kills: bigCounter("kills")
}, (t) => [primaryKey({ columns: [t.accountId, t.animal] })]);

export const accountPeriods = mysqlTable("account_periods", {
    accountId: accountId().notNull(),
    span: varchar("span", { length: 8 }).notNull(),             // day | week | month
    periodKey: varchar("period_key", { length: 10 }).notNull(), // 2024-06-03 / 2024-06
    kills: bigCounter("kills"),
    bestScore: bigCounter("best_score")
}, (t) => [primaryKey({ columns: [t.accountId, t.span] })]);

// Ids replaced by AccountStore.migrateIds(); old tokens keep working through these.
export const legacyIds = mysqlTable("legacy_ids", {
    oldId: varchar("old_id", { length: 64 }).primaryKey(),
    newId: char("new_id", { length: 24 }).notNull()
});

// ---------------------------------------------------------------- social
export const friends = mysqlTable("friends", {
    ownerId: accountId("owner_id").notNull(),
    friendId: accountId("friend_id").notNull(),
    createdAt: varchar("created_at", { length: 32 }).notNull()  // ISO string, as the client expects
}, (t) => [primaryKey({ columns: [t.ownerId, t.friendId] })]);

export const friendRequests = mysqlTable("friend_requests", {
    id: id().primaryKey(),
    senderId: accountId("sender_id").notNull(),
    recipientId: accountId("recipient_id").notNull(),
    createdAt: varchar("created_at", { length: 32 }).notNull()
}, (t) => [index("ix_friend_requests_recipient").on(t.recipientId)]);

// ---------------------------------------------------------------- clans
export const clans = mysqlTable("clans", {
    name: varchar("name", { length: 4 }).primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    closed: boolean("closed").notNull().default(false),
    shadowed: boolean("shadowed").notNull().default(false),
    kills: bigCounter("kills"),
    raidKills: bigCounter("raid_kills")
});

export const clanPeriods = mysqlTable("clan_periods", {
    clanName: varchar("clan_name", { length: 4 }).notNull(),
    span: varchar("span", { length: 8 }).notNull(),             // week | month
    periodKey: varchar("period_key", { length: 10 }).notNull(),
    kills: bigCounter("kills")
}, (t) => [primaryKey({ columns: [t.clanName, t.span] })]);

export const clanMembers = mysqlTable("clan_members", {
    clanName: varchar("clan_name", { length: 4 }).notNull(),
    accountId: accountId().notNull(),
    role: varchar("role", { length: 8 }).notNull().default("member"), // member | officer | owner
    stint: int("stint").notNull().default(1),
    joinedAt: bigint("joined_at", { mode: "number" }).notNull().default(0),
    kills: bigCounter("kills"),
    ord: int("ord").notNull().default(0)                        // join order, for stable lists
}, (t) => [primaryKey({ columns: [t.clanName, t.accountId] })]);

export const clanMemberPeriods = mysqlTable("clan_member_periods", {
    clanName: varchar("clan_name", { length: 4 }).notNull(),
    accountId: accountId().notNull(),
    span: varchar("span", { length: 8 }).notNull(),
    periodKey: varchar("period_key", { length: 10 }).notNull(),
    kills: bigCounter("kills")
}, (t) => [primaryKey({ columns: [t.clanName, t.accountId, t.span] })]);

export const clanPast = mysqlTable("clan_past", {
    clanName: varchar("clan_name", { length: 4 }).notNull(),
    accountId: accountId().notNull(),
    stint: int("stint").notNull().default(1),
    leftAt: bigint("left_at", { mode: "number" }).notNull().default(0),
    kicked: boolean("kicked").notNull().default(false),
    kills: bigCounter("kills"),
    ord: int("ord").notNull().default(0)
}, (t) => [primaryKey({ columns: [t.clanName, t.ord] })]);

export const clanInvites = mysqlTable("clan_invites", {
    clanName: varchar("clan_name", { length: 4 }).notNull(),
    accountId: accountId().notNull(),
    invitedBy: accountId("invited_by").notNull(),
    ord: int("ord").notNull().default(0)
}, (t) => [primaryKey({ columns: [t.clanName, t.accountId] })]);

export const clanRequests = mysqlTable("clan_requests", {
    clanName: varchar("clan_name", { length: 4 }).notNull(),
    accountId: accountId().notNull(),
    ord: int("ord").notNull().default(0)
}, (t) => [primaryKey({ columns: [t.clanName, t.accountId] })]);

// ---------------------------------------------------------------- chat
// One table for both kinds; `thread` is the whisper key ("idA|idB", ids sorted) or the
// clan name. `ord` is the position inside the thread so history replays in order.
export const chatMessages = mysqlTable("chat_messages", {
    id: varchar("id", { length: 16 }).primaryKey(),
    thread: varchar("thread", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 8 }).notNull(),             // whisper | clan
    fromId: accountId("from_id"),
    fromName: varchar("from_name", { length: 15 }).notNull().default(""),
    toId: accountId("to_id"),
    toName: varchar("to_name", { length: 15 }),
    text: varchar("text", { length: 200 }).notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
    shadow: boolean("shadow").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false),
    ord: int("ord").notNull().default(0)
}, (t) => [index("ix_chat_thread").on(t.thread, t.ord)]);

// "What someone said" (staff tool). target: recipient name (whisper), clan name (clan)
// or server key (game).
export const saidLog = mysqlTable("said_log", {
    seq: int("seq").autoincrement().primaryKey(),
    accountId: accountId().notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
    kind: varchar("kind", { length: 8 }).notNull(),             // whisper | clan | game
    target: varchar("target", { length: 64 }),
    text: varchar("text", { length: 200 }).notNull(),
    shadow: boolean("shadow").notNull().default(false),
    ord: int("ord").notNull().default(0)
}, (t) => [index("ix_said_account").on(t.accountId, t.ord)]);

// ---------------------------------------------------------------- moderation
export const bans = mysqlTable("bans", {
    kind: varchar("kind", { length: 8 }).notNull(),             // ip | account | device
    banKey: varchar("ban_key", { length: 64 }).notNull(),       // the ip / account id / device id
    name: varchar("name", { length: 32 }),
    bannedBy: varchar("banned_by", { length: 32 }).notNull().default("system"),
    reason: varchar("reason", { length: 255 }),
    until: bigint("until", { mode: "number" }),                 // null = permanent
    at: varchar("at", { length: 32 }).notNull()                 // ISO string
}, (t) => [primaryKey({ columns: [t.kind, t.banKey] })]);

export const modRecords = mysqlTable("mod_records", {
    accountId: accountId().primaryKey(),
    verdictLevel: varchar("verdict_level", { length: 16 }),     // null = clear
    verdictReason: varchar("verdict_reason", { length: 255 }),
    verdictBy: varchar("verdict_by", { length: 32 }),
    verdictAt: bigint("verdict_at", { mode: "number" })
});

export const modReports = mysqlTable("mod_reports", {
    seq: int("seq").autoincrement().primaryKey(),
    accountId: accountId().notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
    byName: varchar("by_name", { length: 32 }),
    byKind: varchar("by_kind", { length: 8 }),                  // account | guest
    reason: varchar("reason", { length: 255 }),
    sessionReports: int("session_reports"),
    ord: int("ord").notNull().default(0)
}, (t) => [index("ix_mod_reports_account").on(t.accountId, t.ord)]);

export const modFlags = mysqlTable("mod_flags", {
    seq: int("seq").autoincrement().primaryKey(),
    accountId: accountId().notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
    signal: varchar("signal", { length: 32 }).notNull(),
    ord: int("ord").notNull().default(0)
}, (t) => [index("ix_mod_flags_account").on(t.accountId, t.ord)]);

// Append-only moderation log (replaces reports.jsonl). payload holds the flexible part
// (anticheat flag snapshot at report time); everything queryable is a column.
export const reportLog = mysqlTable("report_log", {
    seq: int("seq").autoincrement().primaryKey(),
    at: varchar("at", { length: 32 }).notNull(),                // ISO string
    kind: varchar("kind", { length: 8 }).notNull(),             // report | reason
    targetName: varchar("target_name", { length: 32 }),
    targetAccount: accountId("target_account"),
    reporterName: varchar("reporter_name", { length: 32 }),
    reporterAccount: accountId("reporter_account"),
    reason: varchar("reason", { length: 255 }),
    payload: json("payload")
}, (t) => [index("ix_report_log_target").on(t.targetAccount)]);

// Idempotency markers for the one-shot JSON -> MySQL import.
export const migrationMeta = mysqlTable("migration_meta", {
    mkey: varchar("mkey", { length: 64 }).primaryKey(),
    doneAt: bigint("done_at", { mode: "number" }).notNull()
});
