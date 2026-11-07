#!/usr/bin/env node
/**
 * Ops status writer
 * ---------------------------------------------------------------------------
 * Normalises the result of an external monitor (watchdog, sweep, quota) into a
 * small JSON document that the Worker can read back for the admin dashboard.
 *
 * The external scripts run on GitHub Actions, so the Worker cannot call them.
 * Instead each script writes `<OPS_STATUS_DIR>/<kind>.json`, the workflow
 * publishes it to an `ops-<kind>` branch, and the Worker fetches it from
 * raw.githubusercontent.com. Nothing here is secret: these documents contain
 * counts, statuses and timings only.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const OPS_KINDS = ["quota", "watchdog", "sweep"];

export function opsStatusDir(env = process.env) {
  return resolve(env.OPS_STATUS_DIR || ".ops-status");
}

export function opsRunMeta(env = process.env) {
  const runId = env.GITHUB_RUN_ID || "";
  const repository = env.GITHUB_REPOSITORY || "shreyash7854/vidlyte";
  return {
    kind: "",
    published_at: new Date().toISOString(),
    workflow: env.GITHUB_WORKFLOW || "",
    run_id: runId,
    run_url: runId ? `https://github.com/${repository}/actions/runs/${runId}` : "",
    ref: env.GITHUB_REF_NAME || "",
    event: env.GITHUB_EVENT_NAME || "",
  };
}

/**
 * Write a compact status document. Large result arrays must be trimmed by the
 * caller: this file is fetched by the dashboard, so keep it under ~20 KB.
 */
export async function writeOpsStatus(kind, payload, env = process.env) {
  if (!OPS_KINDS.includes(kind)) throw new Error(`unknown ops kind: ${kind}`);
  const document = {
    kind,
    ...payload,
    _meta: { ...opsRunMeta(env), kind },
  };
  const dir = opsStatusDir(env);
  const file = join(dir, `${kind}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(document, null, 2), "utf8");
  } catch (error) {
    console.error(`ops-status: could not write ${kind}: ${(error && error.message) || error}`);
  }
  return document;
}
