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

## Environment variables

All optional — defaults are baked in:

| Variable | Default | Description |
|---|---|---|
| `LITELLM_API_KEY` | `sk-18Or...` | LiteLLM proxy API key |
| `LITELLM_BASE_URL` | `https://litellm-proxy.ml.scale.com/v1` | LiteLLM proxy URL |
| `LITELLM_MODEL` | `claude-opus-4-8` | Model for the copilot |
| `SANDBOX_TIMEOUT` | `1209600` (14 days) | Sandbox TTL in seconds |
| `SANDBOX_CPU` | `4` | CPU cores |
| `SANDBOX_MEMORY` | `8192` | Memory in MiB |
| `SANDBOX_PROJECT_ID` | `682bdbff5ed4cd9b2516cc6a` | Billing project ID |

## Example with overrides

```bash
LITELLM_MODEL=claude-sonnet-4-6 SANDBOX_TIMEOUT=86400 node sandbox.mjs
```

## Uploading files to a running sandbox

Open the terminal URL and run `rz` — your browser will prompt you to select files (Zmodem transfer).

## Troubleshooting

- **"Cannot reach sandbox.ml-serving-internal.scale.com"** — WARP isn't connected. Check the menu bar icon.
- **"Exec timed out"** — the sandbox VM might be slow; rerun the script (it creates a new sandbox).
- **Upload fails with "Argument list too long"** — the repo is too large; check if `node_modules` or large files snuck in.
