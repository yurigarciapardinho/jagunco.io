import fs from "node:fs";
import path from "node:path";

export function loadFileSecrets(env = process.env) {
  for (const key of [
    "APP_SECRET",
    "DATABASE_URL",
    "CONTROL_SECRET",
    "MIGRATION_DATABASE_URL",
  ]) {
    const file = env[key + "_FILE"];
    if (!file) continue;
    if (env[key])
      throw new Error(`${key}: configure valor ou arquivo, não ambos`);
    let value;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 8192) throw new Error("invalid file");
      value = fs.readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`${key}: arquivo de segredo indisponível`);
    }
    if (!value || /[\r\n\0]/.test(value))
      throw new Error(`${key}: formato de segredo inválido`);
    env[key] = value;
  }
  return env;
}

export function validatePurpose(env = process.env) {
  const purpose = env.APP_PURPOSE || "game";
  if (!["game", "preview", "asset-export"].includes(purpose))
    throw new Error("APP_PURPOSE inválido");
  if (purpose === "preview") {
    const root = "/tmp/jagunco-preview/";
    if (
      env.NODE_ENV === "production" ||
      env.DATABASE_URL ||
      env.DATABASE_URL_FILE ||
      !/^[a-f0-9-]{36}$/.test(env.PREVIEW_SESSION_ID || "") ||
      !path.resolve(env.DATA_DIR || "").startsWith(root) ||
      !env.APP_SECRET
    ) {
      throw new Error(
        "Prévia exige finalidade, sessão e dados descartáveis próprios, sem banco de produção"
      );
    }
  }
  if (
    env.OFFICIAL_CLIENT_DIR &&
    (purpose !== "asset-export" ||
      env.NODE_ENV !== "development" ||
      env.DATABASE_URL ||
      env.HOST !== "127.0.0.1")
  ) {
    throw new Error(
      "Renderer de autoria só pode ser exportado em processo local isolado"
    );
  }
  if (
    env.NODE_ENV === "production" &&
    ["IS_SANDBOX", "SANDBOX_UNLIMITED", "DEBUG_PACKETS"].some(
      k => env[k] && env[k] !== "0"
    )
  ) {
    throw new Error("Flags de desenvolvimento não são permitidas em produção");
  }
  return purpose;
}
