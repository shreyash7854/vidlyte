#!/usr/bin/env node
/**
 * VidLyte Workers Free capacity guard
 * ---------------------------------------------------------------------------
 * Reads today's (UTC) Workers request count from the Cloudflare GraphQL
 * Analytics API and alerts through Telegram before the free-tier limit is hit.
 *
 * This runs outside the Worker on purpose: once the daily limit is exhausted the
 * Worker cannot report it. It needs a read-only token, no billing profile:
 *
 *   CF_API_TOKEN    Account Analytics:Read
 *   CF_ACCOUNT_ID   Cloudflare account tag
 *
 * Env:
 *   QUOTA_DAILY_LIMIT      default 100000 (Workers Free)
 *   QUOTA_WARN_PCT         default 70
 *   QUOTA_CRITICAL_PCT     default 90
 *   QUOTA_COOLDOWN_HOURS   default 6 (dedupe window for repeated alerts)
 *   QUOTA_STATE_DIR        default .quota-state
 *   QUOTA_DRY_RUN          default false
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  optional alert delivery
 *
 * If the Cloudflare credentials are absent the script exits 0 with
 * `skipped: "cloudflare_not_configured"` so the workflow stays green until the
 * owner adds them (see ENV_TODO.md).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const env = process.env;
const API_TOKEN = String(env.CF_API_TOKEN || "").trim();
const ACCOUNT_ID = String(env.CF_ACCOUNT_ID || "").trim();
const DAILY_LIMIT = positiveInt(env.QUOTA_DAILY_LIMIT, 100000);
const WARN_PCT = positiveInt(env.QUOTA_WARN_PCT, 70);
const CRITICAL_PCT = positiveInt(env.QUOTA_CRITICAL_PCT, 90);
const COOLDOWN_MS = positiveInt(env.QUOTA_COOLDOWN_HOURS, 6) * 60 * 60 * 1000;
const STATE_DIR = env.QUOTA_STATE_DIR || ".quota-state";
const STATE_FILE = join(STATE_DIR, "state.json");
const DRY_RUN = isTrue(env.QUOTA_DRY_RUN, false);
const TELEGRAM_TOKEN = String(env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(env.TELEGRAM_CHAT_ID || "").trim();

function isTrue(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function utcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

async function writeState(state) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {}
}

async function sendTelegram(text) {
  if (DRY_RUN) return { sent: false, skipped: "dry_run" };
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, skipped: "telegram_not_configured" };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 3900),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: false,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      return { sent: false, skipped: `telegram_http_${response.status}` };
    }
    return { sent: true, skipped: "" };
  } catch (error) {
    return { sent: false, skipped: String((error && error.name) || "error").slice(0, 60) };
  }
}

const QUERY = `query WorkersDailyUsage($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        sum { requests }
        dimensions { scriptName }
      }
    }
  }
}`;

async function fetchUsage(start, end) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "VidLyte-QuotaGuard/1.0",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        accountTag: ACCOUNT_ID,
        start: start.toISOString(),
        end: end.toISOString(),
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    throw new Error(`graphql_http_${response.status}`);
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const code = String(payload.errors[0] && payload.errors[0].message || "graphql_error")
      .replace(/[^a-z0-9 _-]/gi, "")
      .slice(0, 80);
    throw new Error(code || "graphql_error");
  }

  const accounts = payload.data && payload.data.viewer && payload.data.viewer.accounts;
  const rows = Array.isArray(accounts) && Array.isArray(accounts[0] && accounts[0].workersInvocationsAdaptive)
    ? accounts[0].workersInvocationsAdaptive
    : [];
  const scripts = rows.map((row) => ({
    script: String((row.dimensions && row.dimensions.scriptName) || "unknown"),
    requests: Number(row.sum && row.sum.requests) || 0,
  }));
  const total = scripts.reduce((sum, entry) => sum + entry.requests, 0);
  scripts.sort((a, b) => b.requests - a.requests);
  return { total, scripts: scripts.slice(0, 8) };
}

function levelFor(pct) {
  if (pct >= CRITICAL_PCT) return "critical";
  if (pct >= WARN_PCT) return "warning";
  return "ok";
}

async function main() {
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  const dayStart = utcDayStart(startedAt);

  if (!API_TOKEN || !ACCOUNT_ID) {
    console.log(
      JSON.stringify(
        {
          checked_at: startedIso,
          skipped: "cloudflare_not_configured",
          detail: "Set CF_API_TOKEN and CF_ACCOUNT_ID (read-only analytics) to enable the quota guard.",
          daily_limit: DAILY_LIMIT,
        },
        null,
        2
      )
    );
    return;
  }

  let usage;
  const state = await readState();
  try {
    usage = await fetchUsage(dayStart, startedAt);
  } catch (error) {
    const message = String((error && error.message) || error).slice(0, 120);
    const alert = await sendTelegram(
      [
        "⚠️ <b>VidLyte quota guard failed</b>",
        `• Error: ${escapeHtml(message)}`,
        `• Time: ${new Date().toISOString()}`,
      ].join("\n")
    );
    console.log(
      JSON.stringify(
        { checked_at: startedIso, ok: false, error: message, alert },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const pct = DAILY_LIMIT > 0 ? (usage.total / DAILY_LIMIT) * 100 : 0;
  const level = levelFor(pct);
  const now = Date.now();
  const summary = {
    checked_at: startedIso,
    day_start_utc: dayStart.toISOString(),
    daily_limit: DAILY_LIMIT,
    requests: usage.total,
    percent: Number(pct.toFixed(1)),
    level,
    warn_pct: WARN_PCT,
    critical_pct: CRITICAL_PCT,
    top_scripts: usage.scripts,
    alert: { sent: false, skipped: "not_needed" },
  };

  const previousLevel = String(state.level || "ok");
  const recovered = previousLevel !== "ok" && level === "ok";
  const escalated = level !== "ok" && level !== previousLevel;
  const cooledDown = now - Number(state.last_sent_at || 0) >= COOLDOWN_MS;
  const shouldNotify = recovered || escalated || (level !== "ok" && cooledDown);

  if (shouldNotify) {
    if (recovered) {
      summary.alert = await sendTelegram(
        [
          "✅ <b>VidLyte quota recovered</b>",
          `• Requests today: ${usage.total.toLocaleString()} / ${DAILY_LIMIT.toLocaleString()} (${pct.toFixed(1)}%)`,
          `• Time: ${new Date().toISOString()}`,
        ].join("\n")
      );
    } else {
      const icon = level === "critical" ? "🚨" : "⚠️";
      summary.alert = await sendTelegram(
        [
          `${icon} <b>VidLyte Workers quota ${level}</b>`,
          `• Requests today: ${usage.total.toLocaleString()} / ${DAILY_LIMIT.toLocaleString()} (${pct.toFixed(1)}%)`,
          `• Thresholds: warn ${WARN_PCT}% · critical ${CRITICAL_PCT}%`,
          usage.scripts.length
            ? `• Top scripts: ${usage.scripts.map((entry) => `${entry.script}=${entry.requests}`).join(", ")}`
            : "",
          "• Action: reduce traffic or expect 429s when the free daily limit is reached. Do not add billing.",
          `• Time: ${new Date().toISOString()}`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    if (summary.alert.sent) {
      state.last_sent_at = now;
      state.level = level;
      state.last_requests = usage.total;
      await writeState(state);
    }
  }

  console.log(JSON.stringify(summary, null, 2));

  if (env.GITHUB_STEP_SUMMARY) {
    try {
      const lines = [
        `## Workers quota: ${level.toUpperCase()}`,
        "",
        `- Requests today (UTC): **${usage.total.toLocaleString()} / ${DAILY_LIMIT.toLocaleString()}** (${pct.toFixed(1)}%)`,
        `- Warn ${WARN_PCT}% · Critical ${CRITICAL_PCT}%`,
        usage.scripts.length
          ? `- Top scripts: ${usage.scripts.map((entry) => `\`${entry.script}\` ${entry.requests}`).join(", ")}`
          : "",
        "",
      ];
      await writeFile(env.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
    } catch (e) {}
  }

  if (level === "critical") process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(`quota: fatal error: ${String((error && error.stack) || error).slice(0, 1500)}`);
  await sendTelegram(
    `🚨 <b>VidLyte quota guard crashed</b>\n• ${escapeHtml(error && error.message || error)}\n• Time: ${new Date().toISOString()}`
  );
  process.exitCode = 1;
});
