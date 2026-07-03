# portfolio-status

**Live ops dashboard for [colinshanahan.dev](https://colinshanahan.dev) — because
a portfolio claiming DevOps skills should be monitored like production.**

Azure Application Insights pings the site every 5 minutes from three US
regions. An Azure Function queries that telemetry live (managed identity +
KQL — no keys anywhere) plus recent deploy runs from GitHub, and serves it to
a public status page and the portfolio's built-in terminal.

```
App Insights standard web test (3 regions, every 5 min, SSL expiry check)
        └─► Log Analytics workspace
                └─► Azure Function /api/status
                      ·  managed identity → Log Analytics Reader (least privilege)
                      ·  KQL: uptime %, avg response, hourly series (24h)
                      ·  GitHub API: last 5 deploy runs
                      ·  60s in-memory cache
                └─► status.html  +  `status` command in the site terminal
```

Cost: consumption Function + one web test + 30-day Log Analytics retention
at portfolio traffic ≈ **under $3/month**.

## Layout

```
portfolio-status/
├── api/                    # Node 20 Azure Function (v4 model)
│   └── src/functions/status.js
├── infra/main.tf           # AI + web test + Function App + OIDC deploy identity
├── web/status.html         # the dashboard — copy into the portfolio's site/ folder
└── .github/workflows/deploy.yml
```

## Setup

```bash
# 1. Provision (creates monitoring, function app, CI identity)
cd infra && terraform init && terraform apply
terraform output   # note status_api_url + the three azure_* IDs

# 2. Push this repo to github.com/cjshanahan1228/portfolio-status
#    (the OIDC trust in main.tf is bound to that exact name)

# 3. Repo Settings → Secrets and variables → Actions → Variables:
#    AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID (from step 1)

# 4. Run the "Deploy status API" workflow (or push anything under api/).
#    The workflow ends with a smoke test against the live endpoint.

# 5. Copy web/status.html into the portfolio repo's site/ folder and push —
#    live at colinshanahan.dev/status.html
```

Availability data starts flowing ~15–30 minutes after `terraform apply`;
the page and API degrade gracefully until then.

## Design notes

- **Managed identity end-to-end.** The function reads telemetry as itself —
  `DefaultAzureCredential` → system-assigned identity → `Log Analytics Reader`
  on one workspace. No instrumentation keys, no API keys, nothing to rotate.
- **Partial failure tolerance.** Telemetry and GitHub queries run
  `Promise.allSettled` — a GitHub outage can't blank the uptime numbers, and
  vice versa. Each section of the page degrades independently.
- **Cache as rate-limit strategy.** 60s in-memory cache keeps unauthenticated
  GitHub API usage (60 req/hr) safe at any realistic traffic, and keeps KQL
  query volume negligible.
- **SSL expiry is a check, not a surprise.** The web test fails if the cert
  has <7 days remaining — the classic "the site was up but the cert died"
  page is designed out.
- **CORS is explicit.** Only the portfolio origins may call the API from a
  browser (Terraform `allowed_origins`).

---

Part of a portfolio built as working infrastructure:
[site + IaC](https://github.com/cjshanahan1228/portfolio-project-alpha) ·
[Backstage golden path](https://github.com/cjshanahan1228/azure-golden-path) ·
[Azure DevOps golden path](https://github.com/cjshanahan1228/azdo-golden-path)
