![Preview](https://raw.githubusercontent.com/olixis/pi-openrouter-plus/main/assets/preview.png)

# pi-openrouter-plus

Pi extension for OpenRouter that loads the latest models from OpenRouter in real time, keeps the default model list simple, and lets you enrich a specific model with provider and quantization variants.

Npm package:

- `@corvo_prophet/pi-openrouter-plus`

## Features

- Loads the latest OpenRouter model list into pi in real time
- Keeps startup behavior fast by default
- Adds provider-specific variants on demand
- Adds quantization-specific variants for a chosen model
- Routes enriched selections through OpenRouter provider routing
- Enriches one model at a time to avoid slow full-catalog endpoint scans

## Install

### From npm

```bash
pi install npm:@corvo_prophet/pi-openrouter-plus
```

### From GitHub

```bash
pi install git:github.com/olixis/pi-openrouter-plus
```

### Try without installing

```bash
pi -e npm:@corvo_prophet/pi-openrouter-plus
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

- On startup, the extension syncs the latest plain OpenRouter model list from OpenRouter
- Enrichment is manual and targeted to one model at a time
- Quantization variants are exposed as separate model choices when available
- Enriched variants are translated into OpenRouter provider routing fields at request time
- If you want to go back to the default list, run `/openrouter-sync`

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
