![Preview](https://raw.githubusercontent.com/olixis/pi-openrouter-plus/main/assets/preview.png)

# pi-openrouter-realtime v0.3.0

Pi extension for OpenRouter that loads the latest models from OpenRouter in real time, with provider/quantization enrichment, endpoint health indicators, credit balance display, interactive model picker, and tab-completion.

Once the extension is installed and your OpenRouter credential is configured in pi, each new pi session automatically fetches the latest OpenRouter model list.

Npm package:

- `pi-openrouter-realtime`

## What's New in v0.3.0

- **Targeted enrichment** — enrich one model on demand without scanning the whole catalog
- **Interactive model picker** — run `/openrouter-enrich` without args → type a search query → pick from filtered results
- **Tab-completion** — autocomplete model IDs when typing commands
- **`/openrouter-preview`** — inspect provider variants and endpoint health without changing your model list
- **`/openrouter-balance`** — check your OpenRouter credit balance and usage
- **`/openrouter-status`** — see current extension state, active enrichments, cache age
- **Endpoint health data** — status, uptime, latency (TTFT), throughput per variant
- **Snapshot-based routing** — eliminates race conditions with stale route maps
- **Transactional sync** — state only updates on success, never left in a broken state
- **Fixed cost parsing** — missing pricing no longer shows as "free"
- **Auth detection fix** — works with both env vars and auth.json
- **Fetch timeouts** — 15s timeout prevents hanging on OpenRouter API issues
- **HTTP-Referer / X-Title headers** — proper app identification with OpenRouter

## Features

- Loads the latest OpenRouter model list into pi in real time
- Keeps startup behavior fast by default
- Adds provider-specific variants on demand
- Adds quantization-specific variants for chosen models
- Routes enriched selections through OpenRouter provider routing
- Shows endpoint health: status, uptime, latency, throughput, caching support
- Displays credit balance and usage statistics
- Interactive model selection with searchable picker
- Tab-completes model IDs for all commands

## Install

### 1) Install the extension

From npm:

```bash
pi install npm:pi-openrouter-realtime
```

From GitHub:

```bash
pi install git:github.com/olixis/pi-openrouter-plus
```

### 2) Connect pi to OpenRouter

#### Recommended: use `pi-connect` to set up OpenRouter

The `git:github.com/hk-vk/pi-connect` package makes provider setup much easier and gives you a simple `/connect` flow inside pi.

Install it:

```bash
pi install git:github.com/hk-vk/pi-connect
```

Then open pi and connect OpenRouter:

```bash
pi
/connect openrouter
```

When prompted:

1. Paste your OpenRouter API key
2. Confirm/save it
3. Start a new pi session, or restart the current one

`pi-connect` stores the credential in `~/.pi/agent/auth.json`, and this extension will then automatically fetch the latest models from OpenRouter when pi starts.

#### Official pi ways to connect OpenRouter

Pi supports OpenRouter via either an environment variable or `~/.pi/agent/auth.json`.

Using an environment variable:

```bash
export OPENROUTER_API_KEY=sk-or-...
pi
```

Using `~/.pi/agent/auth.json`:

```json
{
  "openrouter": { "type": "api_key", "key": "sk-or-..." }
}
```

After the key is available, this extension automatically syncs the latest OpenRouter model list at session start.

### 3) Try without installing

```bash
pi -e npm:pi-openrouter-realtime
```

or:

```bash
pi -e git:github.com/olixis/pi-openrouter-plus
```

## Commands

| Command | Description |
|---|---|
| `/openrouter-sync` | Fetch latest OpenRouter models and restore the plain model list |
| `/openrouter-enrich <model-id>` | Add provider/quantization variants for one model |
| `/openrouter-enrich` | Search → pick a model interactively (no args) |
| `/openrouter-preview <model-id>` | Preview endpoint variants with health data (read-only) |
| `/openrouter-preview` | Search → pick a model to preview (no args) |
| `/openrouter-balance` | Show credit balance, remaining funds, and usage breakdown |
| `/openrouter-status` | Show extension state: model count, enrichments, cache age |

## Examples

### Enrich a model

```bash
/openrouter-enrich kwaipilot/kat-coder-pro-v2
```

This keeps the normal OpenRouter catalog and adds variants like:

- `StreamLake — Kwaipilot: KAT-Coder-Pro V2`
- `AtlasCloud · fp8 — Kwaipilot: KAT-Coder-Pro V2`

### Preview endpoints before enriching

```bash
/openrouter-preview deepseek/deepseek-r1
```

Shows provider variants with pricing and health data:

```
DeepSeek: DeepSeek R1 (deepseek/deepseek-r1)
8 endpoints across 5 provider/quantization variants:

• DeepInfra — $0.55/M in · $2.19/M out · ✅ healthy · uptime: 99% · TTFT: 450ms · 85 tok/s
• DeepSeek — $0.55/M in · $2.19/M out · ✅ healthy · uptime: 100% · TTFT: 320ms · 120 tok/s · 📦 caching
• Fireworks · fp8 — $0.60/M in · $2.40/M out · ⚠️ degraded · uptime: 95% · TTFT: 600ms · 60 tok/s
```

### Check your balance

```bash
/openrouter-balance
```

## Behavior

- After the extension is installed and OpenRouter auth is configured, each new pi session syncs the latest OpenRouter model list automatically
- Enrichment is intentionally simple: you enrich one selected model at a time
- Quantization variants are exposed as separate model choices when available
- Enriched variants are translated into OpenRouter provider routing fields at request time
- If you want to refresh manually or go back to the default list, run `/openrouter-sync`
- Preview output also includes search-related model info (id, name, terms, description) plus pricing and endpoint health

## Architecture (v0.3.0 improvements)

- **Snapshot-based routing** — the stream factory captures a frozen route map at registration time, eliminating race conditions when syncing
- **Generation counter** — overlapping sync calls are safely discarded if a newer sync has started
- **Transactional state** — caches are not cleared before fetch; state only commits on success
- **Auth-keyed caching** — model cache invalidates when the API key changes
- **Fetch timeouts** — all OpenRouter API calls have a 15-second timeout via AbortController

## Development

Type-check locally:

```bash
bunx tsc --noEmit
```

or:

```bash
npx tsc --noEmit
```

Test the package locally with pi:

```bash
pi -e .
```

Or load the extension entry file directly:

```bash
pi -e ./extensions/openrouter-routing/index.ts
```

## License

MIT

---

> ⁶ Jesus said unto him, I am the way, the truth, and the life: no man comes unto the Father, but by me.
>
> — *John 14:6*
