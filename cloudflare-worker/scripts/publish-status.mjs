#!/usr/bin/env node
/**
 * Publish an ops status document to a dedicated branch
 * ---------------------------------------------------------------------------
 * Each monitor owns exactly one branch (`ops-quota`, `ops-watchdog`,
 * `ops-sweep`) with a single file (`<kind>.json`). Force-pushing a single
 * orphan commit keeps the repository small while still giving the Worker a
 * public, unauthenticated read URL:
 *
 *   https://raw.githubusercontent.com/<owner>/<repo>/ops-<kind>/<kind>.json
 *
 * Usage:
 *   node scripts/publish-status.mjs quota
 *   node scripts/publish-status.mjs watchdog
 *   node scripts/publish-status.mjs sweep
 *
 * Env:
 *   GITHUB_TOKEN            token with contents:write (Actions supplies this)
 *   GITHUB_REPOSITORY       owner/repo (Actions supplies this)
 *   GITHUB_WORKSPACE        repository root (Actions supplies this)
 *   OPS_STATUS_DIR          default .ops-status
 *   OPS_STATUS_BRANCH_PREFIX default ops-
 *   OPS_STATUS_DRY_RUN      default false
 *
 * Publishing is best-effort: a failure here must never fail the monitor run.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OPS_KINDS, opsStatusDir } from "./ops-status.mjs";

const kind = String(process.argv[2] || "").trim();
const env = process.env;
const prefix = env.OPS_STATUS_BRANCH_PREFIX || "ops-";
const branch = `${prefix}${kind}`;
const dryRun = String(env.OPS_STATUS_DRY_RUN || "").toLowerCase() === "true";
const token = env.GITHUB_TOKEN || "";

function fail(message) {
  console.error(`publish-status: ${message}`);
  process.exit(0); // never fail the monitoring job
}

if (!OPS_KINDS.includes(kind)) fail(`unknown kind "${kind}" (expected ${OPS_KINDS.join(", ")})`);

const source = join(opsStatusDir(env), `${kind}.json`);
let document;
try {
  document = JSON.parse(await readFile(source, "utf8"));
} catch (error) {
  fail(`no readable status at ${source}: ${(error && error.message) || error}`);
}

const repoRoot = env.GITHUB_WORKSPACE || resolve(process.cwd(), "..");
const slug = env.GITHUB_REPOSITORY || remoteSlug(repoRoot);
const remote = token
  ? `https://x-access-token:${token}@github.com/${slug}.git`
  : `https://github.com/${slug}.git`;

function remoteSlug(root) {
  try {
    const url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
    const match = url.trim().match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    return match ? match[1] : "";
  } catch (error) {
    return "";
  }
}

function sanitize(message) {
  const text = String((message && message.message) || message);
  return token ? text.split(token).join("***") : text;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main() {
  if (!slug) fail("cannot determine owner/repo (set GITHUB_REPOSITORY)");

  if (dryRun) {
    console.log(JSON.stringify({ kind, branch, dry_run: true, bytes: JSON.stringify(document).length }, null, 2));
    return;
  }

  const workdir = await mkdtemp(join(tmpdir(), `vidlyte-${kind}-`));
  git(["init", "-q"], workdir);
  git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], workdir);
  await writeFile(join(workdir, `${kind}.json`), JSON.stringify(document, null, 2), "utf8");
  git(["add", "-A"], workdir);
  git(
    [
      "-c", "user.name=vidlyte-ops",
      "-c", "user.email=ops@vidlyte.invalid",
      "commit", "-q",
      "-m", `status(${kind}): ${document.checked_at || new Date().toISOString()}`,
    ],
    workdir
  );
  git(["push", "-q", "--force", remote, `HEAD:refs/heads/${branch}`], workdir);

  console.log(JSON.stringify({
    kind,
    branch,
    published_at: document.checked_at || "",
    run_url: (document._meta && document._meta.run_url) || "",
  }, null, 2));
}

main().catch((error) => fail(sanitize(error)));
