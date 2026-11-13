import test from "node:test";
import assert from "node:assert/strict";
import { validateMessage } from "../../../scripts/check-commits.mjs";
import { validatePullRequest } from "../../../scripts/check-pr.mjs";

test("commit convention accepts scopes, Unicode and explained breaking changes", () => {
    assert.deepEqual(validateMessage("fix(admin): sincroniza poderes e reconexão\n\nValidação: testes completos."), []);
    assert.deepEqual(validateMessage("feat(api)!: altera contrato\n\nAdapta o protocolo.\n\nBREAKING CHANGE: clientes precisam atualizar."), []);
    assert.deepEqual(validateMessage("docs: " + "á".repeat(44) + "\n\nAtualiza o guia."), []);
});

test("commit convention rejects long titles, absent bodies and ambiguous headers", () => {
    for (const message of [
        "atualizações\n\nTexto.",
        "fix: " + "a".repeat(46) + "\n\nTexto.",
        "fix: corrige estado",
        "fix: corrige estado\nTexto.",
        "fix: corrige estado.\n\nTexto.",
        "feat(api)!: altera contrato\n\nSem explicação da quebra."
    ]) assert.ok(validateMessage(message).length, message);
});

test("PR validation checks the final squash message from event or API", () => {
    const valid = { title: "fix(ci): valida título e corpo", body: "Valida a contribuição antes da integração." };
    assert.deepEqual(validatePullRequest({ pull_request: valid }), []);
    assert.deepEqual(validatePullRequest(valid), []);
    assert.deepEqual(validatePullRequest({}), []);
    assert.ok(validatePullRequest({ pull_request: { ...valid, title: "Merge automático" } }).length);
    assert.ok(validatePullRequest({ ...valid, body: "" }).length);
});
