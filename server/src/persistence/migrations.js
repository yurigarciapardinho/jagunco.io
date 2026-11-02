// MIGRATIONS / DDL
// The only place raw SQL lives in the persistence layer (schema versioning). All
// runtime CRUD goes through Drizzle's query API in mysqlDriver.js. Statements are
// CREATE TABLE IF NOT EXISTS so bootstrapping is idempotent; MIGRATIONS is an ordered
// list of {name, statements} batches, each recorded in migration_meta once applied.

export const MIGRATIONS = [
    {
        name: "0001_initial",
        statements: [
            `CREATE TABLE IF NOT EXISTS accounts (
                id CHAR(24) PRIMARY KEY,
                email VARCHAR(120) NOT NULL,
                name VARCHAR(15) NULL,
                role VARCHAR(8) NULL,
                clan VARCHAR(4) NULL,
                verdict VARCHAR(16) NULL,
                created_at BIGINT NOT NULL,
                look_json JSON NULL,
                best_look_json JSON NULL,
                unlocks_json JSON NULL,
                discord_name VARCHAR(32) NULL,
                discord_linked_at BIGINT NULL,
                password_credential VARCHAR(512) NULL,
                UNIQUE KEY uq_accounts_email (email),
                UNIQUE KEY uq_accounts_name (name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS account_prefs (
                account_id CHAR(24) PRIMARY KEY,
                friend_notifs TINYINT(1) NOT NULL DEFAULT 1,
                friend_requests TINYINT(1) NOT NULL DEFAULT 1,
                clan_invites TINYINT(1) NOT NULL DEFAULT 1,
                clan_chat TINYINT(1) NOT NULL DEFAULT 1,
                whispers TINYINT(1) NOT NULL DEFAULT 1
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS account_socials (
                account_id CHAR(24) PRIMARY KEY,
                youtube VARCHAR(32) NULL,
                twitch VARCHAR(32) NULL,
                tiktok VARCHAR(32) NULL,
                x VARCHAR(32) NULL,
                discord VARCHAR(32) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS account_stats (
                account_id CHAR(24) PRIMARY KEY,
                kills BIGINT NOT NULL DEFAULT 0,
                deaths BIGINT NOT NULL DEFAULT 0,
                damage BIGINT NOT NULL DEFAULT 0,
                healing BIGINT NOT NULL DEFAULT 0,
                wood BIGINT NOT NULL DEFAULT 0,
                food BIGINT NOT NULL DEFAULT 0,
                stone BIGINT NOT NULL DEFAULT 0,
                gold BIGINT NOT NULL DEFAULT 0,
                animal_damage BIGINT NOT NULL DEFAULT 0,
                best_score BIGINT NOT NULL DEFAULT 0,
                max_kills BIGINT NOT NULL DEFAULT 0,
                lives BIGINT NOT NULL DEFAULT 0,
                playtime BIGINT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS account_animal_kills (
                account_id CHAR(24) NOT NULL,
                animal VARCHAR(32) NOT NULL,
                kills BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (account_id, animal)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS account_periods (
                account_id CHAR(24) NOT NULL,
                span VARCHAR(8) NOT NULL,
                period_key VARCHAR(10) NOT NULL,
                kills BIGINT NOT NULL DEFAULT 0,
                best_score BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (account_id, span)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS legacy_ids (
                old_id VARCHAR(64) PRIMARY KEY,
                new_id CHAR(24) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS friends (
                owner_id CHAR(24) NOT NULL,
                friend_id CHAR(24) NOT NULL,
                created_at VARCHAR(32) NOT NULL,
                PRIMARY KEY (owner_id, friend_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS friend_requests (
                id CHAR(24) PRIMARY KEY,
                sender_id CHAR(24) NOT NULL,
                recipient_id CHAR(24) NOT NULL,
                created_at VARCHAR(32) NOT NULL,
                KEY ix_friend_requests_recipient (recipient_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clans (
                name VARCHAR(4) PRIMARY KEY,
                created_at BIGINT NOT NULL,
                closed TINYINT(1) NOT NULL DEFAULT 0,
                shadowed TINYINT(1) NOT NULL DEFAULT 0,
                kills BIGINT NOT NULL DEFAULT 0,
                raid_kills BIGINT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clan_periods (
                clan_name VARCHAR(4) NOT NULL,
                span VARCHAR(8) NOT NULL,
                period_key VARCHAR(10) NOT NULL,
                kills BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (clan_name, span)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clan_members (
                clan_name VARCHAR(4) NOT NULL,
                account_id CHAR(24) NOT NULL,
                role VARCHAR(8) NOT NULL DEFAULT 'member',
                stint INT NOT NULL DEFAULT 1,
                joined_at BIGINT NOT NULL DEFAULT 0,
                kills BIGINT NOT NULL DEFAULT 0,
                ord INT NOT NULL DEFAULT 0,
                PRIMARY KEY (clan_name, account_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clan_member_periods (
                clan_name VARCHAR(4) NOT NULL,
                account_id CHAR(24) NOT NULL,
                span VARCHAR(8) NOT NULL,
                period_key VARCHAR(10) NOT NULL,
                kills BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (clan_name, account_id, span)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clan_past (
                clan_name VARCHAR(4) NOT NULL,
                account_id CHAR(24) NOT NULL,
                stint INT NOT NULL DEFAULT 1,
                left_at BIGINT NOT NULL DEFAULT 0,
                kicked TINYINT(1) NOT NULL DEFAULT 0,
                kills BIGINT NOT NULL DEFAULT 0,
                ord INT NOT NULL DEFAULT 0,
                PRIMARY KEY (clan_name, ord)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clan_invites (
                clan_name VARCHAR(4) NOT NULL,
                account_id CHAR(24) NOT NULL,
                invited_by CHAR(24) NOT NULL,
                ord INT NOT NULL DEFAULT 0,
                PRIMARY KEY (clan_name, account_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS clan_requests (
                clan_name VARCHAR(4) NOT NULL,
                account_id CHAR(24) NOT NULL,
                ord INT NOT NULL DEFAULT 0,
                PRIMARY KEY (clan_name, account_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS chat_messages (
                id VARCHAR(16) PRIMARY KEY,
                thread VARCHAR(64) NOT NULL,
                kind VARCHAR(8) NOT NULL,
                from_id CHAR(24) NULL,
                from_name VARCHAR(15) NOT NULL DEFAULT '',
                to_id CHAR(24) NULL,
                to_name VARCHAR(15) NULL,
                text VARCHAR(200) NOT NULL,
                at BIGINT NOT NULL,
                shadow TINYINT(1) NOT NULL DEFAULT 0,
                is_system TINYINT(1) NOT NULL DEFAULT 0,
                ord INT NOT NULL DEFAULT 0,
                KEY ix_chat_thread (thread, ord)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS said_log (
                seq INT AUTO_INCREMENT PRIMARY KEY,
                account_id CHAR(24) NOT NULL,
                at BIGINT NOT NULL,
                kind VARCHAR(8) NOT NULL,
                target VARCHAR(64) NULL,
                text VARCHAR(200) NOT NULL,
                shadow TINYINT(1) NOT NULL DEFAULT 0,
                ord INT NOT NULL DEFAULT 0,
                KEY ix_said_account (account_id, ord)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS bans (
                kind VARCHAR(8) NOT NULL,
                ban_key VARCHAR(64) NOT NULL,
                name VARCHAR(32) NULL,
                banned_by VARCHAR(32) NOT NULL DEFAULT 'system',
                reason VARCHAR(255) NULL,
                \`until\` BIGINT NULL,
                at VARCHAR(32) NOT NULL,
                PRIMARY KEY (kind, ban_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS mod_records (
                account_id CHAR(24) PRIMARY KEY,
                verdict_level VARCHAR(16) NULL,
                verdict_reason VARCHAR(255) NULL,
                verdict_by VARCHAR(32) NULL,
                verdict_at BIGINT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS mod_reports (
                seq INT AUTO_INCREMENT PRIMARY KEY,
                account_id CHAR(24) NOT NULL,
                at BIGINT NOT NULL,
                by_name VARCHAR(32) NULL,
                by_kind VARCHAR(8) NULL,
                reason VARCHAR(255) NULL,
                session_reports INT NULL,
                ord INT NOT NULL DEFAULT 0,
                KEY ix_mod_reports_account (account_id, ord)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS mod_flags (
                seq INT AUTO_INCREMENT PRIMARY KEY,
                account_id CHAR(24) NOT NULL,
                at BIGINT NOT NULL,
                \`signal\` VARCHAR(32) NOT NULL,
                ord INT NOT NULL DEFAULT 0,
                KEY ix_mod_flags_account (account_id, ord)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS report_log (
                seq INT AUTO_INCREMENT PRIMARY KEY,
                at VARCHAR(32) NOT NULL,
                kind VARCHAR(8) NOT NULL,
                target_name VARCHAR(32) NULL,
                target_account CHAR(24) NULL,
                reporter_name VARCHAR(32) NULL,
                reporter_account CHAR(24) NULL,
                reason VARCHAR(255) NULL,
                payload JSON NULL,
                KEY ix_report_log_target (target_account)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

            `CREATE TABLE IF NOT EXISTS migration_meta (
                mkey VARCHAR(32) PRIMARY KEY,
                done_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        ]
    },
    {
        // password_credential was briefly JSON; it is a known scrypt string, so make it
        // VARCHAR(512). Fresh installs already have the right column from 0001, so this
        // only alters databases created with the JSON variant, and existing values are
        // preserved (JSON string scalars are unquoted into the new column).
        name: "0002_password_credential_varchar",
        async run(pool) {
            const [rows] = await pool.query(
                `SELECT DATA_TYPE AS dataType FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'password_credential'`
            );
            if (!rows.length) {
                await pool.query(`ALTER TABLE accounts ADD COLUMN password_credential VARCHAR(512) NULL`);
                return;
            }
            if (String(rows[0].dataType).toLowerCase() !== "json") return;
            await pool.query(`ALTER TABLE accounts ADD COLUMN password_credential_v VARCHAR(512) NULL`);
            await pool.query(`UPDATE accounts SET password_credential_v = password_credential->>'$' WHERE password_credential IS NOT NULL`);
            await pool.query(`ALTER TABLE accounts DROP COLUMN password_credential`);
            await pool.query(`ALTER TABLE accounts CHANGE password_credential_v password_credential VARCHAR(512) NULL`);
        }
    }
];
