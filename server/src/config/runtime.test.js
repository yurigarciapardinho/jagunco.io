import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFileSecrets, validatePurpose } from "./runtime.js";

test("file secrets are explicit, bounded and never echoed on errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-secrets-"));
  try {
    const file = path.join(dir, "key");
    fs.writeFileSync(file, "synthetic-secret\n");
    assert.equal(
      loadFileSecrets({ APP_SECRET_FILE: file }).APP_SECRET,
      "synthetic-secret"
    );
    assert.throws(
      () =>
        loadFileSecrets({ APP_SECRET: "private-value", APP_SECRET_FILE: file }),
      /não ambos/
    );
    fs.writeFileSync(file, "first\nsecond");
    assert.throws(
      () => loadFileSecrets({ APP_SECRET_FILE: file }),
      error => !error.message.includes("first") && /formato/.test(error.message)
    );
    assert.throws(
      () => loadFileSecrets({ DATABASE_URL_FILE: dir }),
      /indisponível/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preview refuses production storage and incomplete isolation configuration", () => {
  const env = {
    APP_PURPOSE: "preview",
    NODE_ENV: "development",
    APP_SECRET: "synthetic",
    PREVIEW_SESSION_ID: "12345678-1234-1234-1234-123456789abc",
    DATA_DIR: "/tmp/jagunco-preview/session",
  };
  assert.equal(validatePurpose(env), "preview");
  for (const change of [
    { DATABASE_URL: "mysql://invalid/example" },
    { NODE_ENV: "production" },
    { DATA_DIR: "/app/server/data" },
    { PREVIEW_SESSION_ID: "" },
  ]) {
    assert.throws(() => validatePurpose({ ...env, ...change }), /Prévia/);
  }
  assert.throws(
    () => validatePurpose({ NODE_ENV: "production", IS_SANDBOX: "1" }),
    /Flags/
  );
  assert.throws(
    () =>
      validatePurpose({
        OFFICIAL_CLIENT_DIR: "/tmp/export",
        NODE_ENV: "production",
      }),
    /Renderer/
  );
});
