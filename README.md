<p align="center">
  <a>
    <img alt="chameleon logo" src="assets/chameleon.png" width="132">
  </a>
</p>

<p align="center">
  <a href="https://discord.com/users/thearijiiiitttt_"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://notion.so/chameleon-docs"><img alt="Notion" src="https://img.shields.io/badge/notion-docs-000000?style=flat-square&logo=notion&logoColor=white" /></a>
</p>

<p align="center">
  <b>chameleon</b> privacy-preserving browser agent 🦎
</p>


> **New to this project?** Don't worry, this guide explains everything step by step, with no skipped steps.


## Table of Contents

1. [What is CHAMELEON?](#-what-is-chameleon)
2. [Before You Start](#-before-you-start)
3. [Installation](#-installation)
4. [Getting an API Key](#-getting-an-api-key)
5. [Running CHAMELEON](#-running-chameleon)
6. [Components](#-components)
7. [Talking to CHAMELEON](#-talking-to-chameleon)
8. [Safety & Approval Flow](#-safety--approval-flow)
9. [Permanent Memory (LIMITATIONS.md)](#-permanent-memory-limitationsmd)
10. [Environment Variables](#-environment-variables)
11. [Deploying the Server](#-deploying-the-server)
12. [Testing & Benchmarks](#-testing--benchmarks)
13. [Troubleshooting](#-troubleshooting)
14. [Learn More](#-learn-more)

<br/>

## What is CHAMELEON?

**CHAMELEON** is a privacy-preserving visual browser agent that runs as a Chrome extension. You give it a task in plain English, and it reads your screen, strips out anything sensitive before it ever leaves your device, and asks a reasoning server what to do next — **with you staying in full control**.

CHAMELEON stands out with its **"sanitize-before-send"** pipeline: every password, email, face, and document is detected and redacted locally, and an independent outbound firewall double-checks the payload before it's allowed anywhere near the network.

**CHAMELEON can:**
- Read and understand the current page (DOM, OCR, and real on-device vision models)
- Detect and redact sensitive data locally — passwords, emails, phone numbers, addresses, faces, documents
- Classify screen regions (document, table, chart) with a real trained Vision Transformer
- Ask a server for the next action and execute it (after your confirmation)
- Show live confidence and privacy metrics while it works
- Run against an offline mock provider or a real LLM/VLM

<br/>

## Before You Start

You need:
- **Node.js 18.17+**
- **Google Chrome** (Firefox is built the same way but not yet verified)
- No API key required for the offline demo

<br/>

## Installation

```bash
# 1. Go to the project folder
cd chameleon

# 2. Install dependencies
npm install

# 3. Build the shared packages
npm run build:packages
```

<br/>

## Getting an API Key

1. Go to any OpenAI-compatible provider of your choice
2. Create an API key
3. Create a `.env` file inside `apps/server`:

```env
# --- Server (default: offline mock provider, no key needed) ---
AI_PROVIDER=mock

# --- Real LLM/VLM provider (optional, replaces the mock) ---
# AI_PROVIDER=openai-compatible
# AI_BASE_URL=https://your-endpoint/v1
# AI_MODEL=your-model-id
# AI_API_KEY=sk-...

# Optional — only if AI_MODEL can actually see images
# AI_VISION_ENABLED=true

# --- Misc ---
PORT=8787
CORS_ORIGIN=*
MAX_REQUEST_BYTES=262144
```

<br/>

## Running CHAMELEON

```bash
cd apps/server && npm run build && npm start
```

## Start the Extension

chrome://extensions → Developer mode → Load unpacked → dist-chrome

Build the extension first if you haven't:

```bash
cd apps/extension
npx vite build --outDir dist-chrome
npx vite build --config vite.background.config.ts --outDir dist-chrome
npx vite build --config vite.content.config.ts --outDir dist-chrome
cp manifest.chrome.json dist-chrome/manifest.json
```

You will see the CHAMELEON icon appear in your toolbar.

<br/>

## Components

| Component     | Description                              | Runs Where   | Best Use Case                     |
|---------------|-------------------------------------------|--------------|------------------------------------|
| **Extension** | Perception, redaction, action execution   | Your browser | Reading pages, redacting, acting  |
| **Server**    | Reasoning over sanitized context          | Anywhere     | Deciding what to click/scroll next |
| **Vault**     | Local token↔value storage                 | Your browser | Typing redacted values back safely |

<br/>

## Talking to CHAMELEON

**Examples:**

```bash
Analyze satellite anomaly; acknowledge incident.
Open the detailed telemetry report.
Scroll down to the power subsystem.
Read the document on this page.
```

CHAMELEON will show live privacy and confidence metrics in real-time and ask for your confirmation before executing any action.

<br/>

## Safety & Approval Flow

- All sensitive fields are **redacted locally** before anything is sent.
- An independent **outbound firewall** re-scans every payload, blocking raw PII even if a detector missed it.
- Every action requires your **explicit confirmation** before it runs on the page.
- The server can never issue an arbitrary instruction — only a fixed, validated set of actions (click, type, scroll, focus, extract).

This makes CHAMELEON one of the **safest** browser agents available.

<br/>

## Permanent Memory (LIMITATIONS.md)

Read `docs/LIMITATIONS.md` before assuming anything is finished. CHAMELEON documents every real gap and every real fix in the open — nothing is quietly hidden.

**Example entries:**

```markdown
# What's real vs what isn't

- OCR: real, self-hosted, bug-fixed, verified in a live browser
- Face detection: real, bundled model, verified against a real photo
- Vision Transformer: real, trained from scratch, verified for numerical parity
- Firefox: written to spec, never verified in an actual Firefox
- Resource/latency: real numbers, disclosed 1-vCPU/no-GPU methodology
```

<br/>

## Environment Variables

| Variable              | Description                              |
|------------------------|------------------------------------------|
| `AI_PROVIDER`          | `mock` (offline) or `openai-compatible` |
| `AI_VISION_ENABLED`    | Send a redacted screenshot to a VLM     |
| `VITE_SERVER_URL`      | Server URL the extension talks to       |
| `VITE_VLM_ENABLED`     | Enable the client-side screenshot capture |
| `CORS_ORIGIN`          | Allowed origin(s) for the server         |
| `MAX_REQUEST_BYTES`    | Hard cap on incoming request size       |

<br/>

## Deploying the Server

```bash
cd apps/server
npm install
npm run build
npm start
```

The server has **no dependency on the rest of the repo** — copy just `apps/server` anywhere (Docker, Render, Railway, a plain VPS) and deploy it on its own. See `apps/server/README.md` and the included `Dockerfile`/`Procfile`/`render.yaml` for ready-made deploy paths.

<br/>

## Testing & Benchmarks

```bash
npm test                                        # full suite
npm run typecheck                               # type-safety check
npx tsx benchmark/run-benchmark.ts              # synthetic-page PII detection
npx tsx benchmark/run-external-benchmark.ts     # real, externally-authored dataset
```

<br/>

## Troubleshooting

| Problem                            | Solution |
|--------------------------------------|--------|
| Extension icon does nothing          | Check the server is running: `curl localhost:8787/health` |
| Popup shows "—" instead of a percentage | Normal until the server responds with a real action |
| Face/document detection does nothing | Expected on plain pages — only scans images/canvases ≥48px |
| `npm install` complains about internal packages | Run `npm run build:packages` from the repo root first |

<br/>

