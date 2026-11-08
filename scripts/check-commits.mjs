#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function validateMessage(message) {
    const [title, separator, ...body] = message.trimEnd().split(/\r?\n/);
    const errors = [];
    const match = /^(feat|fix|docs|test|refactor|perf|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9/-]*\))?(!)?: (\S.*)$/.exec(title || "");
    if (!match) errors.push("use tipo(escopo): descrição com um tipo permitido");
    if (Array.from(title || "").length > 50) errors.push("o título excede 50 caracteres");
    if (/[.。]$/.test(title || "")) errors.push("remova o ponto final do título");
    if (separator !== "" || !body.some(line => line.trim())) errors.push("inclua um corpo após uma linha vazia");
    if (match?.[2] && !body.some(line => /^BREAKING CHANGE: \S/.test(line))) errors.push("explique a incompatibilidade em BREAKING CHANGE:");
    return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const option = (name, fallback) => {
        const at = args.indexOf(name);
        if (at < 0) return fallback;
        if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error("valor ausente: " + name);
        return args[at + 1];
    };
    for (let i = 0; i < args.length; i += 2) {
        if (!["--from", "--to"].includes(args[i])) throw new Error("opção desconhecida: " + args[i]);
    }
    const from = option("--from", "origin/main"), to = option("--to", "HEAD");
    const git = (...values) => execFileSync("git", values, { encoding: "utf8" }).trimEnd();
    const base = git("rev-parse", "--verify", from + "^{commit}");
    const head = git("rev-parse", "--verify", to + "^{commit}");
    const commits = git("rev-list", "--reverse", base + ".." + head).split("\n").filter(Boolean);
    let failed = 0;
    for (const sha of commits) {
        const errors = validateMessage(git("show", "-s", "--format=%B", sha));
        if (errors.length) {
            failed++;
            console.error(sha.slice(0, 8) + ": " + errors.join("; "));
        }
    }
    console.log(commits.length + " commits verificados; " + failed + " inválidos.");
    process.exitCode = failed ? 1 : 0;
}
