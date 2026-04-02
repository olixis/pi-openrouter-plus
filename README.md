![Preview](https://raw.githubusercontent.com/olixis/pi-openrouter-plus/main/assets/preview.png)

# pi-openrouter-realtime

Pi extension for OpenRouter that loads the latest models from OpenRouter in real time, keeps the default model list simple, and lets you enrich a specific model with provider and quantization variants.

Once the extension is installed and your OpenRouter credential is configured in pi, each new pi session automatically fetches the latest OpenRouter model list.

Npm package:

- `pi-openrouter-realtime`

## Features

- Loads the latest OpenRouter model list into pi in real time
- Keeps startup behavior fast by default
- Adds provider-specific variants on demand
- Adds quantization-specific variants for a chosen model
- Routes enriched selections through OpenRouter provider routing
- Enriches one model at a time to avoid slow full-catalog endpoint scans

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

Pi's official provider docs use:

- Environment variable: `OPENROUTER_API_KEY`
- `auth.json` key: `openrouter`

After the key is available, this extension automatically syncs the latest plain OpenRouter model list at session start.

### 3) Try without installing

```bash
pi -e npm:pi-openrouter-realtime
```

or:

```bash
pi -e git:github.com/olixis/pi-openrouter-plus
```

## Commands

- `/openrouter-sync` — fetch the latest OpenRouter model list in real time
- `/openrouter-enrich <model-id>` — add provider and quantization variants for one specific OpenRouter model

## Example

```bash
/openrouter-enrich kwaipilot/kat-coder-pro-v2
```

This keeps the normal OpenRouter catalog and adds variants like:

- `Kwaipilot: KAT-Coder-Pro V2 (StreamLake)`
- `Kwaipilot: KAT-Coder-Pro V2 (AtlasCloud · fp8)`

## Behavior

- After the extension is installed and OpenRouter auth is configured, each new pi session syncs the latest plain OpenRouter model list from OpenRouter automatically
- Enrichment is manual and targeted to one model at a time
- Quantization variants are exposed as separate model choices when available
- Enriched variants are translated into OpenRouter provider routing fields at request time
- If you want to refresh manually or go back to the default list, run `/openrouter-sync`

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
