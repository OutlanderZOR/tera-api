# Running tera-api with Docker Compose

End-to-end walkthrough from a fresh repo checkout to a running stack on a Linux host (or Docker Desktop on Windows/macOS). Assumes basic familiarity with `docker compose`.

## 1. Prerequisites

- Docker Engine and Docker Compose (`docker compose version`).
- ~2 GB of free disk for images + MySQL volume.
- Host ports `80`, `3306`, `8040`, `8050`, `8080` available, or remap them in `docker-compose.yml`.
- A `DataCenter_Final_<region>.dat` file from a TERA game client for the region you intend to serve (e.g. `EUR`). Without it the Portal API will refuse to start.

## 2. Clone and enter the repo

```bash
git clone <repo-url> tera-api
cd tera-api
```

## 3. Create the `.env` file

```bash
cp .env.example .env
```

Edit `.env` and change at least these keys for the Docker network:

| Key | Set to | Why |
|---|---|---|
| `DB_HOST` | `mysql` | Compose service name of the database container. |
| `DB_USERNAME` | `root` | The image initializes the root user. |
| `DB_PASSWORD` | choose one | Must match `MYSQL_ROOT_PASSWORD` in compose (default `teraapi`). |
| `DB_DATABASE` | `teraapi` | Must match the DB created by the mysql image. |
| `API_ARBITER_LISTEN_HOST` | `0.0.0.0` | Default `127.0.0.1` is unreachable from outside the container. |
| `API_GATEWAY_LISTEN_HOST` | `0.0.0.0` | Same reason. |
| `API_PORTAL_SECRET` | a random string | Session encryption key. |
| `ADMIN_PANEL_SECRET` | a random string | Session encryption key. |

If you change `DB_PASSWORD`, also export it before running compose so the mysql container picks it up:

```bash
export DB_PASSWORD=your-password   # Linux/macOS
$env:DB_PASSWORD="your-password"   # PowerShell
```

## 4. Place the DataCenter file

Copy the `.dat` from your game client into `./data/datasheets/`:

```
./data/datasheets/DataCenter_Final_EUR.dat
```

Region must match `API_PORTAL_LOCALE` / `API_PORTAL_CLIENT_DEFAULT_REGION` in `.env`. KEY/IV in `.env.example` are the standard public-known TERA values; override only if your client uses a different pair.

The `data/captcha-images/`, `data/shop-slides-bg/`, and `data/tera-icons/` folders are populated automatically on first boot from `share/data/*.zip`.

## 5. Build the image

```bash
docker compose build
```

The build uses a multi-stage Dockerfile: a `deps` stage with native build toolchain (cairo, pango, jpeg, gif, rsvg, python3) for `canvas`, and a slim `runtime` stage that ships only the runtime libraries plus `tini`. The base image is `node:24-bookworm-slim`, and `deps` runs `npm ci` against the committed `package-lock.json` for reproducible installs.

## 6. First boot

```bash
docker compose up -d
```

What happens on the first run:

1. MySQL 5.7 starts, creates the `teraapi` database, becomes healthy.
2. tera-api container starts, the entrypoint extracts `share/data/shop-slides-bg.zip` and `share/data/tera-icons.zip` into `data/...` (skipped on subsequent boots).
3. Sequelize connects to MySQL and creates ~32 tables, then writes `dbVersion=3` to `global_property`.
4. The four API servers bind: Portal `:80`, Gateway `:8040`, Admin `:8050`, Arbiter `:8080`.

Watch the logs:

```bash
docker compose logs -f tera-api
```

You should see `Core: $ Server ready $` followed by the version banner.

## 7. Seed the SQL data

The SQL files in `share/db/` are *data seeds*, not schema — they must run **after** the API has created the tables (i.e. after step 6). Run them with the dedicated seed service:

```bash
docker compose run --rm db-seed
```

The service applies every `*.sql` file in `share/db/` in lexicographic order, then exits. The SQL files are idempotent, so re-running is safe.

Verify:

```bash
docker compose exec -T mysql mysql -uroot -pteraapi teraapi \
  -e "SELECT COUNT(*) FROM server_strings; SELECT COUNT(*) FROM shop_products;"
```

Expected: 11 server_strings, 2197 shop_products.

## 8. Smoke test

```bash
curl -I http://localhost:8050/    # Admin Panel login page
curl -I http://localhost/         # Portal API
```

Admin panel default credentials (test only): `apiadmin` / `password` (failed logins are rate-limited). For production, enable OIDC login (`OIDC_ENABLE=true` plus the `OIDC_*` keys) and treat the QA credential as break-glass with a strong password; see the README "Admin Panel" section.

## 9. Day-to-day commands

```bash
docker compose ps                       # status
docker compose logs -f tera-api         # follow API logs
docker compose logs --tail=200 mysql    # last 200 mysql lines
docker compose restart tera-api         # restart only the API
docker compose down                     # stop, keep volumes
docker compose down -v                  # stop and wipe MySQL data + extracted assets
docker compose build --no-cache         # full rebuild
docker compose pull                     # update mysql image
```

Run a single component (mirrors the upstream `npm run start_*` scripts):

```bash
docker compose run --rm tera-api node --expose-gc src/app --component arbiter_api
```

Open a MySQL shell:

```bash
docker compose exec mysql mysql -uroot -pteraapi teraapi
```

## 10. Where state lives

| Path | Purpose | Bind-mounted from host? |
|---|---|---|
| named volume `mysql_data` | MySQL data files | No (managed by Docker) |
| `./data/` | datasheets, icons, slides, captcha, geoip | Yes |
| `./config/` | runtime config overrides (`*.js` files) | Yes |
| `./public/` | launcher static files, client patches | Yes |
| `./logs/` | API log files | Yes |
| `./sessions/` | session-file-store data | Yes |
| `./.env` | environment variables | Yes (read-only) |

To back up: snapshot the `mysql_data` volume (`docker run --rm -v tera-api_mysql_data:/d -v $PWD:/b alpine tar czf /b/db.tgz -C /d .`) plus the bind-mounted dirs.

## 11. OpenTelemetry tracing (optional)

The instrumentation packages ship in the image but nothing loads them unless `NODE_OPTIONS` carries the zero-code hook. Leave `NODE_OPTIONS` unset and the container behaves exactly as before.

```yaml
services:
  tera-api:
    environment:
      NODE_OPTIONS: "--require @opentelemetry/auto-instrumentations-node/register"
      OTEL_SERVICE_NAME: "tera-api"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318"
      OTEL_TRACES_EXPORTER: "otlp"
      OTEL_METRICS_EXPORTER: "none"
      OTEL_LOGS_EXPORTER: "none"
      OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,express,mysql2,tedious"
      OTEL_NODE_RESOURCE_DETECTORS: "env,host,os,process,serviceinstance,container"
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio"
      OTEL_TRACES_SAMPLER_ARG: "0.1"
```

| Key | Why |
|---|---|
| `NODE_OPTIONS` | The only switch. Loads the hook before `src/app.js` runs. |
| `OTEL_SERVICE_NAME` | The node name in a service graph. All four components share one process, so they share one name. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL. Port `4318` is OTLP/HTTP; the SDK default protocol is `http/protobuf` and it appends `/v1/traces`. |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | Both default to `otlp` when unset. Set `none` for traces only; container logs already reach the log stack over stdout. |
| `OTEL_NODE_ENABLED_INSTRUMENTATIONS` | Allowlist. `http` pairs the inbound SERVER span, `express` supplies `http.route`, `mysql2` covers Sequelize, `tedious` covers the Planet (MSSQL) databases. |
| `OTEL_NODE_RESOURCE_DETECTORS` | Without it the SDK probes the AWS/GCP/Azure metadata endpoints on every boot, which times out slowly on a plain VM. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_traceidratio` honors a decision already made by the caller, which is what keeps a cross-service trace whole. The ratio only applies to traces that start here. |

Notes:

- These must be real container environment variables (`environment:` or `env_file:`). The hook runs before `src/app.js` calls `dotenv`, so `OTEL_*` keys written into `.env` are invisible to it.
- Instrumentation short names are the suffix of the `@opentelemetry/instrumentation-*` package name. An unrecognized name is ignored without a warning, so a typo silently drops that instrumentation.
- Trace context is W3C `traceparent`, propagated by default. The app sends no CORS headers of its own, so a browser caller must reach it same-origin through a reverse proxy for the header to survive.
- The Platform Hub link is a raw TCP protobuf socket and stays uninstrumented.

## 12. Troubleshooting

**App crash-loops with `Could not find datasheets for Portal API language: en`** — DataCenter file missing or wrong region. See step 4.

**App crash-loops with `ECONNREFUSED 127.0.0.1:11001`** — only a warning; the Hub is optional and the API will continue. Hard crashes from this line indicate a different issue; check the surrounding log context.

**MySQL container marked unhealthy** — usually a wrong/changed `MYSQL_ROOT_PASSWORD` against an existing `mysql_data` volume. `docker compose down -v` to wipe and re-init (destroys data).

**Port 80/3306/8080 already in use** — edit the `ports:` mappings in `docker-compose.yml`.

**`canvas` build failures on `docker compose build`** — should not happen with the bundled Dockerfile (prebuilt binary is preferred). If it does, add the missing `lib*-dev` package to the `deps` stage.

**Asset zips not extracted** — the entrypoint only extracts when the target directory contains nothing other than the upstream `!Unpack ... .txt` placeholders. If you partially populated those folders manually, either finish the extraction by hand or empty them and restart the container.
