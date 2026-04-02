![Preview](https://raw.githubusercontent.com/olixis/pi-openrouter-plus/main/assets/preview.png)

# pi-openrouter-plus

Pi extension for OpenRouter that keeps the default model list simple and lets users enrich a specific model with provider and quantization variants.

## Features

- Syncs the normal OpenRouter model list into pi
- Keeps startup behavior fast by default
- Adds provider-specific and quantization-specific variants on demand
- Routes enriched selections through OpenRouter provider routing
- Enriches one model at a time to avoid slow full-catalog endpoint scans

## Install

### From npm

```bash
pi install npm:pi-openrouter-plus
```

### From GitHub

```bash
pi install git:github.com/olixis/pi-openrouter-plus
```

### Try without installing

```bash
pi -e npm:pi-openrouter-plus
```

or:

```bash
pi -e git:github.com/olixis/pi-openrouter-plus
```

## Commands

- `/openrouter-sync` — fetch the latest plain OpenRouter model list
- `/openrouter-enrich <model-id>` — add provider/quantization variants for one specific OpenRouter model

## Example

```bash
/openrouter-enrich kwaipilot/kat-coder-pro-v2
```

This keeps the normal OpenRouter catalog and adds variants like:

- `Kwaipilot: KAT-Coder-Pro V2 (StreamLake)`
- `Kwaipilot: KAT-Coder-Pro V2 (AtlasCloud · fp8)`

## Behavior

- On startup, the extension syncs the plain OpenRouter model list
- Enrichment is manual and targeted to one model at a time
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
