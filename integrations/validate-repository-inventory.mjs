#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateRepositoryInventory(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, count: 0, errors: ["Inventory must be a JSON object."] };
  }
  if (input.schema !== "heavenzfire.repository-inventory-snapshot.v1") {
    errors.push("Unexpected inventory schema.");
  }
  if (!Array.isArray(input.repositories)) {
    errors.push("repositories must be an array.");
    return { ok: false, count: 0, errors };
  }
  if (!Number.isInteger(input.result_count) || input.result_count !== input.repositories.length) {
    errors.push("result_count must equal repositories.length.");
  }
  if (input.integration_status_default !== "unassessed") {
    errors.push("New snapshot entries must default to unassessed.");
  }
  const seen = new Set();
  for (let i = 0; i < input.repositories.length; i += 1) {
    const repo = input.repositories[i];
    const at = "repositories[" + i + "]";
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) {
      errors.push(at + " must be an object.");
      continue;
    }
    if (typeof repo.full_name !== "string" || !/^[^/]+\/[^/]+$/.test(repo.full_name)) {
      errors.push(at + ".full_name must be owner/repository.");
    } else if (seen.has(repo.full_name.toLowerCase())) {
      errors.push("Duplicate repository: " + repo.full_name);
    } else {
      seen.add(repo.full_name.toLowerCase());
    }
    if (typeof repo.name !== "string" || !repo.name.trim()) errors.push(at + ".name is required.");
    if (!["unassessed", "candidate", "verified_component", "integrated", "blocked"].includes(repo.integration_status)) {
      errors.push(at + ".integration_status must use a documented inventory state.");
    }
    if (repo.default_branch !== null && (typeof repo.default_branch !== "string" || !repo.default_branch.trim())) {
      errors.push(at + ".default_branch must be a non-empty string or null.");
    }
    if (!["public", "private", "internal", "unknown"].includes(repo.visibility)) {
      errors.push(at + ".visibility is invalid.");
    }
    if (typeof repo.archived !== "boolean") errors.push(at + ".archived must be boolean.");
    if (repo.size_kb !== null && (!Number.isInteger(repo.size_kb) || repo.size_kb < 0)) {
      errors.push(at + ".size_kb must be a non-negative integer or null.");
    }
    if (typeof repo.url !== "string" || !repo.url.startsWith("https://github.com/")) {
      errors.push(at + ".url must be a GitHub HTTPS URL.");
    }
  }
  return { ok: errors.length === 0, count: input.repositories.length, errors };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node validate-repository-inventory.mjs <snapshot.json>");
  const input = JSON.parse(await readFile(path, "utf8"));
  const result = validateRepositoryInventory(input);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error("Repository inventory validation error: " + error.message); process.exitCode = 1; });
}
