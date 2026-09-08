# CHAMELEON reasoning server

This is a standalone, deployable Node/Express service. It has **no
dependency on the rest of the CHAMELEON monorepo** — no `@chameleon/*`
workspace packages, no `extends`-based `tsconfig.json`, nothing that
requires `packages/` to exist alongside it. You can copy this one folder
anywhere (a separate git repo, a PaaS deploy root, a Docker build
context) and it works on its own. This was verified for real during
development — see `../../docs/DEPLOYMENT.md` for exactly how.

It receives an already-sanitized, PII-free screen description from the
browser extension, asks an LLM (or the built-in offline mock) what to do
next, and returns a small set of validated UI actions (`CLICK`, `TYPE`,
`SCROLL`, `FOCUS`). It never receives raw page content, screenshots, or
unredacted text — and it independently re-scans every incoming request
for PII patterns as a server-side safety net in case something slipped
past the client (`SERVER_SANITY_CHECK_FAILED` in the smoke test output
below is that check firing correctly).

## Quick local run

```bash
npm install
cp .env.example .env      # defaults to AI_PROVIDER=mock - no API key needed
npm run build
npm start                 # listens on :8787 (or $PORT)
```

Or for iterative development (auto-restart on change, no separate build
step):

```bash
npm install
npm run dev
```

Verify it's alive:

```bash
curl http://localhost:8787/health
# {"status":"ok","aiProvider":"mock"}
```

Run the bundled smoke test (spins the server up in-process, exercises a
normal request, a scroll-intent request, a request with a leaked raw
email the server must reject, and a malformed payload the server must
reject):

```bash
npx tsx scripts/smoke-test.ts
```

## Deploying

### Docker

```bash
docker build -t chameleon-server .
docker run -p 8787:8787 --env-file .env chameleon-server
```

The `Dockerfile` is a standard two-stage Node 20-alpine build (compile
with devDependencies, then copy only `dist/` + production
`node_modules` into a slim runtime image, running as a non-root user).
It was written to mirror the exact steps verified in
`docs/DEPLOYMENT.md`, but — unlike that plain `npm install`/`build`/`start`
path — it was not build-tested with an actual Docker daemon in the
environment this repo was prepared in. Treat your first `docker build`
as the first real test of it, the same as you would for any new
Dockerfile.

### Render / Railway / Heroku / any Node buildpack PaaS

- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- A `Procfile` (`web: npm start`) and a `heroku-postbuild` script (runs
  `npm run build` automatically after install) are included for
  Heroku-style platforms that look for them.
- A `render.yaml` blueprint is provided at the **repo root** (one level
  up), for deploying straight from the monorepo with `rootDir: apps/server`.
  If you've copied this folder out into its own repo instead, drop the
  `rootDir` line and deploy it as the repo root.
- Set `PORT` from the platform's own injected env var — `config.ts`
  already reads `process.env.PORT`, defaulting to `8787` only when unset.

### Bare VM / systemd

```bash
npm install --omit=dev
npm run build   # or build once locally/in CI and ship dist/ + node_modules
node dist/index.js
```

Put a reverse proxy (nginx/Caddy) in front for TLS; the app itself only
speaks plain HTTP.

## Required environment variables

See `.env.example` for the full list with comments. The only one that
changes behavior meaningfully:

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `mock` | `mock` = fully offline, deterministic, no API key. `openai-compatible` = real LLM; requires `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`. |
| `AI_VISION_ENABLED` | `false` | Opt-in VLM support - when `true` and `AI_PROVIDER=openai-compatible`, a request carrying `screen.redactedScreenshot` (a client-side, already pixel-redacted screenshot) has that image included as a real `image_url` content block. Requires a vision-capable model. |
| `PORT` | `8787` | Most PaaS platforms override this automatically. |
| `CORS_ORIGIN` | `*` | Tighten this to your extension's actual origin in production. |
| `MAX_REQUEST_BYTES` | `262144` | Hard cap on request body size (payload-size abuse guard). |

**Never commit a real `.env`** — `.gitignore` already excludes it, but
double-check before pushing to a public repo, especially if
`AI_API_KEY` is set.

## What this server does NOT do

- It never sees raw screenshots or unredacted page text — only the
  sanitized, structured payload the extension already produced.
- It has no database, no session/auth of its own, and no persistence —
  every request is stateless.
- It doesn't serve the browser extension itself; the extension is built
  and loaded separately (`apps/extension/`), and only talks to this
  server over HTTP.
