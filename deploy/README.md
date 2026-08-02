# Deploy to Sandbox

Spins up a Scale sandbox VM, installs Node.js, deploys the app, and starts ttyd (web terminal).

## Quick start

```bash
cd deploy
npm install        # first time only
node sandbox.mjs
```

The script takes ~3 minutes. When it finishes, it prints the app URL and terminal URL.

## Prerequisites

- **Node.js 18+** on your local machine
- **Cloudflare WARP** connected (the sandbox control plane is on the internal network)
  - Check the WARP icon in your menu bar — it should show "Connected"
  - If DNS fails, try disconnecting and reconnecting WARP

## What it does

1. Creates a sandbox VM (Ubuntu 22.04, 4 CPU, 8GB RAM, 50GB disk, 14-day TTL)
2. Waits for the VM to boot and cloud-init to finish
3. Starts ttyd on port 8080 (web terminal with file upload via `rz`)
4. Installs Node.js 22
5. Tars the repo, uploads it to the sandbox, extracts it
6. Runs `npm ci --omit=dev`
7. Starts the app on port 4100

## What is *not* shipped

The tarball excludes `.git`, `node_modules`, **`.env`**, and — unless you opt in —
**`workspace/` and `data/`**.

`.env` is excluded because the sandbox also exposes a public web terminal, so a
secrets file on that disk is a second copy of the key sitting somewhere reachable.
The values are injected as real environment variables when the app starts instead,
which `src/config.js` prefers over the file anyway.

`workspace/` and `data/` are your local board: real customer tasks plus the action
and usage logs. Excluding them takes the upload from ~177MB (about 4,000 sequential
60KB chunks) to ~1.3MB (31), and keeps customer data off a shared host. A deploy
without them comes up with:

- an **empty board** — all four buckets present, no tasks
- **re-seeded logins** — the defaults in `src/auth.js`, so change them before sharing
- the **rubric intact** — `getRubric()` falls back to `spec/V11_RUBRIC.csv`

Set `SANDBOX_INCLUDE_BOARD=true` to ship the board anyway.

## Environment variables

Read from the repo's gitignored `.env` — the same file the app reads locally — so a
deploy carries whatever key currently works. A real environment variable overrides it.
Keys are deliberately **not** committed; rotating one in `.env` is all the next deploy
needs.

| Variable | Default | Description |
|---|---|---|
| `LITELLM_API_KEY` | from `../.env` — **required** | LiteLLM proxy API key. Deploy aborts if absent |
| `LITELLM_BASE_URL` | `https://litellm-proxy.ml.scale.com/v1` | LiteLLM proxy URL |
| `LITELLM_MODEL` | `claude-opus-5` | Model for the copilot |
| `REDASH_API_KEY` | from `../.env` — optional | Redash **user** key. Without it the L12 live panels, the per-task Pipeline tab, `redash_query` and `/redash.html` all read "not configured". A query-scoped key 403s on the registry's ad-hoc SQL |
| `REDASH_ANALYTICS_DATA_SOURCE_ID` | `22` | Data source the analytics SQL runs against — not the pull's `30` |
| `ACC_PROJECT_ID` | `69979ab5a4b6d80af7b7d1c8` | ACC project the dashboards describe |
| `SANDBOX_INCLUDE_BOARD` | unset (off) | `true` ships `workspace/` + `data/` — real customer data, much slower upload |
| `SANDBOX_TIMEOUT` | `1209600` (14 days) | Sandbox TTL in seconds |
| `SANDBOX_CPU` | `4` | CPU cores |
| `SANDBOX_MEMORY` | `8192` | Memory in MiB |
| `SANDBOX_PROJECT_ID` | `682bdbff5ed4cd9b2516cc6a` | Billing project ID |

## Example with overrides

```bash
LITELLM_MODEL=claude-sonnet-4-6 SANDBOX_TIMEOUT=86400 node sandbox.mjs

# ship the live board too (slow, and it is customer data)
SANDBOX_INCLUDE_BOARD=true node sandbox.mjs
```

## Uploading files to a running sandbox

Open the terminal URL and run `rz` — your browser will prompt you to select files (Zmodem transfer).

## Troubleshooting

- **"Cannot reach sandbox.ml-serving-internal.scale.com"** — WARP isn't connected. Check the menu bar icon.
- **"Exec timed out"** — the sandbox VM might be slow; rerun the script (it creates a new sandbox).
- **Upload fails with "Argument list too long"** — the repo is too large; check if `node_modules` or large files snuck in.
