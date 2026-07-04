const { app } = require("@azure/functions");
const { DefaultAzureCredential } = require("@azure/identity");
const { LogsQueryClient, LogsQueryResultStatus } = require("@azure/monitor-query");

// DefaultAzureCredential -> system-assigned managed identity in Azure.
// No keys, no connection strings, nothing to rotate.
const logsClient = new LogsQueryClient(new DefaultAzureCredential());

// Query the App Insights COMPONENT store directly via queryResource().
// Lesson learned in production: on this resource, availability results are
// visible in the component's own store (classic schema) but never arrive in
// the linked Log Analytics workspace — so query where the data verifiably is.
const AI_RESOURCE_ID = process.env.APPINSIGHTS_RESOURCE_ID;
const GITHUB_REPO = process.env.GITHUB_REPO || "cjshanahan1228/colinshanahan.dev-portfolio";

// 60s in-memory cache: keeps GitHub's unauthenticated rate limit (60/hr)
// and query volume comfortable at portfolio traffic levels.
let cache = { at: 0, body: null };
const CACHE_MS = 60_000;

async function queryAvailability() {
  const summaryKql = `
    availabilityResults
    | where timestamp > ago(24h)
    | extend ok = tostring(success) in ("1", "true", "True")
    | summarize total = count(),
                passed = countif(ok),
                avgMs = round(avg(duration), 0)`;

  const seriesKql = `
    availabilityResults
    | where timestamp > ago(24h)
    | summarize avgMs = round(avg(duration), 0) by bin(timestamp, 1h)
    | order by timestamp asc`;

  // Banner status comes from the last 30 minutes — "are we up NOW" —
  // while uptime24h stays an honest trailing average. A recovered site
  // shouldn't wear a "down" banner for a day while old failures age out.
  const currentKql = `
    availabilityResults
    | where timestamp > ago(30m)
    | extend ok = tostring(success) in ("1", "true", "True")
    | summarize recentTotal = count(),
                recentPassed = countif(ok)`;

  const [summary, series, current] = await Promise.all([
    logsClient.queryResource(AI_RESOURCE_ID, summaryKql, { duration: "P1D" }),
    logsClient.queryResource(AI_RESOURCE_ID, seriesKql, { duration: "P1D" }),
    logsClient.queryResource(AI_RESOURCE_ID, currentKql, { duration: "PT1H" }),
  ]);

  const site = { status: "unknown", uptime24h: null, avgResponseMs: null, checksLast24h: 0 };

  if (summary.status === LogsQueryResultStatus.Success && summary.tables[0]?.rows.length) {
    const cols = summary.tables[0].columnDescriptors.map((c) => c.name);
    const row = Object.fromEntries(summary.tables[0].rows[0].map((v, i) => [cols[i], v]));
    site.checksLast24h = Number(row.total) || 0;
    if (site.checksLast24h > 0) {
      site.uptime24h = Math.round((Number(row.passed) / site.checksLast24h) * 10000) / 100;
      site.avgResponseMs = Number(row.avgMs);
    }
  }

  // Banner status = NOW (last 30 min of checks), not the 24h average.
  if (current.status === LogsQueryResultStatus.Success && current.tables[0]?.rows.length) {
    const ccols = current.tables[0].columnDescriptors.map((c) => c.name);
    const crow = Object.fromEntries(current.tables[0].rows[0].map((v, i) => [ccols[i], v]));
    const recentTotal = Number(crow.recentTotal) || 0;
    const recentPassed = Number(crow.recentPassed) || 0;
    if (recentTotal > 0) {
      site.status =
        recentPassed === recentTotal ? "operational" : recentPassed > 0 ? "degraded" : "down";
    }
  }

  let responseSeries = [];
  if (series.status === LogsQueryResultStatus.Success && series.tables[0]) {
    const cols = series.tables[0].columnDescriptors.map((c) => c.name);
    responseSeries = series.tables[0].rows.map((r) => {
      const o = Object.fromEntries(r.map((v, i) => [cols[i], v]));
      return { t: o.timestamp, ms: Number(o.avgMs) };
    });
  }

  return { site, responseSeries };
}

async function queryDeploys() {
  // Public repo -> unauthenticated is fine behind the cache.
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/deploy.yml/runs?per_page=5&status=completed`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = await res.json();
  return (data.workflow_runs || []).map((r) => ({
    sha: r.head_sha.slice(0, 7),
    status: r.conclusion,
    branch: r.head_branch,
    when: r.updated_at,
    url: r.html_url,
  }));
}

app.http("status", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (_req, context) => {
    if (Date.now() - cache.at < CACHE_MS && cache.body) {
      return { jsonBody: cache.body, headers: { "x-cache": "hit" } };
    }

    // Partial failure tolerance: a GitHub hiccup shouldn't take down uptime
    // reporting, and vice versa. Each section degrades independently.
    const [avail, deploys] = await Promise.allSettled([queryAvailability(), queryDeploys()]);

    const body = {
      generatedAt: new Date().toISOString(),
      site:
        avail.status === "fulfilled"
          ? avail.value.site
          : { status: "unknown", error: "telemetry query failed" },
      responseSeries: avail.status === "fulfilled" ? avail.value.responseSeries : [],
      deploys: deploys.status === "fulfilled" ? deploys.value : [],
    };

    if (avail.status === "rejected") context.error("availability query failed", avail.reason);
    if (deploys.status === "rejected") context.warn("github query failed", deploys.reason);

    cache = { at: Date.now(), body };
    return { jsonBody: body };
  },
});
