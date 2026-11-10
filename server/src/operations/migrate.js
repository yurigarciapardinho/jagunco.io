import { MySqlPersistence } from "../persistence/mysqlDriver.js";
import { loadFileSecrets } from "../config/runtime.js";
loadFileSecrets();
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL_FILE obrigatório");
process.env.MIGRATE_ON_BOOT = "1";
const persistence = new MySqlPersistence({
  databaseUrl: process.env.MIGRATION_DATABASE_URL,
  dataDir: process.env.DATA_DIR || "/app/server/data",
  log: () => {},
});
try {
  const [[lock]] = await persistence.pool.query(
    "SELECT GET_LOCK('jagunco-game-schema',10) AS acquired"
  );
  if (!lock.acquired) throw new Error("Migration locked");
  await persistence.ready();
  console.log("Migrações do jogo concluídas");
} finally {
  await persistence.pool
    .query("DO RELEASE_LOCK('jagunco-game-schema')")
    .catch(() => {});
  await persistence.close();
}
