#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { validateMessage } from "./check-commits.mjs";
export function validatePullRequest(event) {
  const pr = event?.pull_request || (event?.title ? event : null);
  return pr ? validateMessage(pr.title + "\n\n" + (pr.body || "")) : [];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.PR_REVIEW_FILE || process.env.GITHUB_EVENT_PATH;
  const errors = file ? validatePullRequest(JSON.parse(fs.readFileSync(file, "utf8"))) : [];
  if (errors.length) {
    console.error("Título/corpo do PR: " + errors.join("; "));
    process.exitCode = 1;
  } else console.log("Convenção do PR aprovada ou evento sem PR.");
}

