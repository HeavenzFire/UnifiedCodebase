#!/usr/bin/env node
import process from "node:process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultWorkerHost } from "./default-worker-host.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `HeavenzFire Unified Field task host

Commands:
  workers
  submit <task-json | ->
  approve <task-id> <actor> <reason>
  dispatch <task-id> <extension-id> <actor> <reason>
  list
  status
  audit

submit reads JSON from an argument or stdin when the argument is "-".
Task metadata must include a capability and the corresponding input/evidence fields.
Every dispatch requires a prior explicit approval. No arbitrary shell commands are executed.
State directory: HEAVENZFIRE_STATE_DIR or ~/.heavenzfire/unified-field
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}
function requireArgs(args, count, command) {
  if (args.length < count || args.slice(0, count).some(value => !value || !value.trim())) {
    throw new Error("Missing required arguments for " + command + ".\n" + USAGE);
  }
}
function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }
  const stateDirectory = resolve(process.env.HEAVENZFIRE_STATE_DIR || join(homedir(), ".heavenzfire", "unified-field"));
  const host = await createDefaultWorkerHost({
    repositoryRoot: ROOT,
    taskFilePath: join(stateDirectory, "tasks.jsonl"),
    approvalFilePath: join(stateDirectory, "approvals.jsonl"),
    resultFilePath: join(stateDirectory, "worker-results.jsonl"),
    evidenceLedgerPath: join(stateDirectory, "guardian-evidence.jsonl"),
  });

  switch (command) {
    case "workers":
      output(host.listWorkers());
      return;
    case "submit": {
      requireArgs(args, 1, command);
      const serialized = args[0] === "-" ? await readStdin() : args.join(" ");
      if (!serialized) throw new Error("submit requires a JSON task payload.");
      output(host.submit(JSON.parse(serialized)));
      return;
    }
    case "approve":
      requireArgs(args, 3, command);
      output(host.approve(args[0], { actor: args[1], reason: args.slice(2).join(" ") }));
      return;
    case "dispatch":
      requireArgs(args, 4, command);
      output(await host.dispatch(args[0], args[1], { actor: args[2], reason: args.slice(3).join(" ") }));
      return;
    case "list":
      output(host.listTasks());
      return;
    case "status":
      output(host.workerStatus());
      return;
    case "audit": {
      const audit = host.audit();
      output({
        taskEvents: audit.tasks.length,
        approvalEvents: audit.approvals.length,
        resultRecords: audit.results.length,
        resultChainHead: audit.results.at(-1)?.hash ?? null,
      });
      return;
    }
    default:
      throw new Error("Unknown command: " + command + "\n" + USAGE);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
