import fs from "node:fs";
import path from "node:path";

// One-shot operator helper. Only these mounted directories and known data files.
const roots = ["/app/server/data", "/run/jagunco-control"];
const files = [
  "accounts.json",
  "chat.json",
  "bans.json",
  "moderation.json",
  "reports.jsonl",
  "secret.key",
  "admin.token",
  "protocol-build.json",
];
for (const root of roots) {
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  if (fs.lstatSync(root).isSymbolicLink())
    throw new Error("Diretório de dados não pode ser symlink");
  fs.chownSync(root, 1000, 1000);
  fs.chmodSync(root, 0o750);
}
const data = roots[0];
for (const name of files) {
  const file = path.join(data, name);
  if (!fs.existsSync(file)) continue;
  if (!fs.lstatSync(file).isFile())
    throw new Error("Tipo de arquivo de dados inesperado");
  fs.chownSync(file, 1000, 1000);
  fs.chmodSync(file, 0o600);
}
const protocol = path.join(data, "protocol");
fs.mkdirSync(protocol, { recursive: true, mode: 0o700 });
if (fs.lstatSync(protocol).isSymbolicLink())
  throw new Error("Diretório de protocolo inválido");
fs.chownSync(protocol, 1000, 1000);
fs.chmodSync(protocol, 0o700);
console.log("Diretórios de dados e socket preparados para UID 1000.");
