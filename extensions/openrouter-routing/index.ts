import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  OPENROUTER_BASE_URL,
  PROVIDER_NAME,
  type ProviderModelConfig,
  type RouteVariant,
} from "./types.js";
import { invalidateAllCaches, fetchKeyInfo, fetchCredits, fetchModels, fetchModelEndpoints } from "./api.js";
import { toProviderModel, groupEndpoints, formatEndpointHealth, parseCost } from "./models.js";
import { createStreamFactory } from "./routing.js";
import { createModelPicker, rankModelsForQuery } from "./picker.js";
import {
  getSnapshot,
  nextGeneration,
  isStale,
  buildPlainSync,
  buildEnrichedSync,
  commitSnapshot,
  getCachedModelList,
} from "./state.js";

const REFERER_HEADER = "https://github.com/olixis/pi-openrouter-plus";
const APP_TITLE = "pi-openrouter-realtime";

function emitMessage(pi: ExtensionAPI, text: string) {
  pi.sendMessage({
    customType: "openrouter-info",
    content: text,
    display: true,
  });
}

function sanitizeSearchText(text?: string): string {
  return (text || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function maxDefined(values: Array<number | undefined>, fallback?: number): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  if (defined.length > 0) return Math.max(...defined);
  return fallback;
}

function formatPerMillion(cost: number): string {
  if (cost === 0) return "$0/M";
  if (cost < 0.01) return `$${cost.toFixed(4)}/M`;
  if (cost < 1) return `$${cost.toFixed(3)}/M`;
  return `$${cost.toFixed(2)}/M`;
}

function buildPricingParts(
  input?: number,
  output?: number,
  cacheRead?: number,
  cacheWrite?: number,
): string[] {
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${formatPerMillion(input)} in`);
  if (output !== undefined) parts.push(`${formatPerMillion(output)} out`);
  if (cacheRead !== undefined) parts.push(`${formatPerMillion(cacheRead)} cache-read`);
  if (cacheWrite !== undefined) parts.push(`${formatPerMillion(cacheWrite)} cache-write`);
  return parts;
}

function buildPreviewSearchInfo(target: { id: string; name: string; description?: string; pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }): string[] {
  const tokenizedId = target.id.replace(/[/:_.-]+/g, " ");
  const terms = Array.from(new Set([target.id, tokenizedId, target.name].map(sanitizeSearchText).filter(Boolean)));
  const lines = [
    "**Search info**",
    `- Searchable id: ${target.id}`,
    `- Searchable name: ${target.name}`,
  ];

  if (terms.length > 0) {
    lines.push(`- Search terms: ${terms.join(" | ")}`);
  }

  const basePricing = buildPricingParts(
    parseCost(target.pricing?.prompt),
    parseCost(target.pricing?.completion),
    parseCost(target.pricing?.input_cache_read),
    parseCost(target.pricing?.input_cache_write),
  );
  if (basePricing.length > 0) {
    lines.push(`- Base pricing: ${basePricing.join(" · ")}`);
  }

  if (target.description) {
    lines.push(`- Description: ${sanitizeSearchText(target.description)}`);
  }

  return lines;
}

function buildVariantPricingInfo(target: { pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }, endpoints: Array<{ pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } }>): string {
  const input = maxDefined(endpoints.map((e) => parseCost(e.pricing?.prompt)), parseCost(target.pricing?.prompt));
  const output = maxDefined(endpoints.map((e) => parseCost(e.pricing?.completion)), parseCost(target.pricing?.completion));
  const cacheRead = maxDefined(endpoints.map((e) => parseCost(e.pricing?.input_cache_read)), parseCost(target.pricing?.input_cache_read));
  const cacheWrite = maxDefined(endpoints.map((e) => parseCost(e.pricing?.input_cache_write)), parseCost(target.pricing?.input_cache_write));
  return buildPricingParts(input, output, cacheRead, cacheWrite).join(" · ");
}

export default function openrouterModelsExtension(pi: ExtensionAPI) {
  // ---------- Provider registration ----------

  function registerWithSnapshot(
    models: ProviderModelConfig[],
    routes: ReadonlyMap<string, RouteVariant>,
  ) {
    pi.registerProvider(PROVIDER_NAME, {
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "OPENROUTER_API_KEY",
      api: "openai-completions",
      models,
      headers: {
        "HTTP-Referer": REFERER_HEADER,
        "X-Title": APP_TITLE,
      },
      streamSimple: createStreamFactory(routes),
    });
  }

  // ---------- Core sync logic ----------

  async function syncPlain(ctx: any, silent = false, force = false) {
    const generation = nextGeneration();

    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      if (!silent) ctx.ui.notify("Fetching OpenRouter models...", "info");

      const result = await buildPlainSync(apiKey, force);

      if (isStale(generation)) return;
      commitSnapshot(generation, result.models, result.routes);
      registerWithSnapshot(result.models, result.routes);

      if (!silent) {
        ctx.ui.notify(`OpenRouter: ${result.modelCount} models synced`, "info");
      }
    } catch (err: any) {
      if (!silent) ctx.ui.notify(`OpenRouter sync failed: ${err?.message}`, "error");
    }
  }

  async function syncEnriched(ctx: any, targetModelId: string) {
    const generation = nextGeneration();

    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      ctx.ui.notify(`Fetching endpoint variants for ${targetModelId}...`, "info");

      const result = await buildEnrichedSync(targetModelId, apiKey, false);

      if (isStale(generation)) return;
      commitSnapshot(generation, result.models, result.routes, result.enrichedModelIds);
      registerWithSnapshot(result.models, result.routes);

      const failuresText =
        result.endpointFailures > 0 ? `, ${result.endpointFailures} endpoint failures` : "";
      const enrichedList = Array.from(result.enrichedModelIds).join(", ");
      const totalRegistered = result.models.length;
      ctx.ui.notify(
        `OpenRouter: ${totalRegistered} models registered (${result.variantCount} variants) [${enrichedList}]${failuresText}`,
        "info",
      );
    } catch (err: any) {
      ctx.ui.notify(`OpenRouter enrich failed: ${err?.message}`, "error");
    }
  }

  // ---------- Autocomplete helper ----------

  function modelCompletions(prefix: string) {
    const cached = getCachedModelList();
    if (!cached) return null;

    const raw = prefix.trim();
    const ranked = rankModelsForQuery(cached, raw);

    return ranked.slice(0, 20).map((m) => ({
      value: m.id,
      label: m.id,
      description: m.name,
    }));
  }

  // ---------- Interactive picker (overlay modal with fuzzy search) ----------

  async function pickModel(ctx: any, title: string): Promise<string | undefined> {
    const cached = getCachedModelList();
    if (!cached || cached.length === 0) {
      ctx.ui.notify("No models cached. Run /openrouter-sync first.", "warning");
      return undefined;
    }

    const result = await ctx.ui.custom(
      (tui: any, theme: any, keybindings: any, done: (result: string | null) => void) => {
        return createModelPicker(tui, theme, keybindings, done, cached, title);
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%" as const,
          maxHeight: "70%" as const,
          row: "14%" as const,
          col: "50%" as const,
          minWidth: 60,
        },
      },
    );

    return result || undefined;
  }

  // ---------- Auto-sync on session start ----------

  pi.on("session_start", async (_event, ctx) => {
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      if (apiKey) {
        await syncPlain(ctx, true, true);
        updateStatusBar(ctx);
      }
    } catch {
      // No auth configured — skip silently
    }
  });

  // ---------- Commands ----------

  pi.registerCommand("openrouter-sync", {
    description: "Fetch latest OpenRouter models and restore the plain model list",
    handler: async (_args, ctx) => {
      invalidateAllCaches();
      await syncPlain(ctx, false, true);
      updateStatusBar(ctx);
    },
  });

  pi.registerCommand("openrouter-enrich", {
    description:
      "Add provider/quantization variants for a model",
    getArgumentCompletions: modelCompletions,
    handler: async (args, ctx) => {
      const modelId = args.trim();

      if (!modelId) {
        const picked = await pickModel(ctx, "Search models to enrich");
        if (!picked) return;
        await syncEnriched(ctx, picked);
        updateStatusBar(ctx);
        return;
      }

      await syncEnriched(ctx, modelId);
      updateStatusBar(ctx);
    },
  });

  pi.registerCommand("openrouter-preview", {
    description: "Preview provider/quantization variants for a model without changing the model list",
    getArgumentCompletions: modelCompletions,
    handler: async (args, ctx) => {
      let modelId = args.trim();

      if (!modelId) {
        const picked = await pickModel(ctx, "Search models to preview");
        if (!picked) return;
        modelId = picked;
      }

      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
        ctx.ui.notify(`Fetching endpoints for ${modelId}...`, "info");

        const models = await fetchModels(apiKey);
        const target = models.find((m) => m.id === modelId);
        if (!target) {
          ctx.ui.notify(`Model not found: ${modelId}`, "error");
          return;
        }

        const endpoints = await fetchModelEndpoints(modelId, apiKey, true);
        if (endpoints.length === 0) {
          ctx.ui.notify(`No endpoints found for ${modelId}`, "warning");
          return;
        }

        const groups = groupEndpoints(target, endpoints);
        const lines: string[] = [
          `**${target.name}** (${target.id})`,
          `${endpoints.length} endpoints across ${groups.length} provider/quantization variants:`,
          "",
        ];

        lines.push(...buildPreviewSearchInfo(target), "");
        lines.push("**Endpoint variants**", "");

        for (const group of groups) {
          const r = group.route;
          const label = r.quantization
            ? `${r.providerName} · ${r.quantization}`
            : r.providerName;
          const pricing = buildVariantPricingInfo(target, group.endpoints);
          const health = formatEndpointHealth(r);
          const details = [pricing, health].filter(Boolean).join(" · ");
          lines.push(`• **${label}**${details ? ` — ${details}` : ""}`);
        }

        emitMessage(pi, lines.join("\n"));
      } catch (err: any) {
        ctx.ui.notify(`Preview failed: ${err?.message}`, "error");
      }
    },
  });

  pi.registerCommand("openrouter-balance", {
    description: "Show your OpenRouter credit balance and usage",
    handler: async (_args, ctx) => {
      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
        if (!apiKey) {
          ctx.ui.notify("No OpenRouter API key configured", "warning");
          return;
        }

        const [info, credits] = await Promise.all([
          fetchKeyInfo(apiKey),
          fetchCredits(apiKey),
        ]);

        const lines: string[] = ["**OpenRouter Account**", ""];

        // Balance first — the most important info
        if (credits && credits.total_credits !== undefined && credits.total_usage !== undefined) {
          const balance = credits.total_credits - credits.total_usage;
          lines.push(`💰 **Balance: $${balance.toFixed(4)}**`);
          lines.push(`   Credits: $${credits.total_credits.toFixed(4)} — Used: $${credits.total_usage.toFixed(4)}`);
        } else if (info.limit_remaining !== null && info.limit_remaining !== undefined) {
          lines.push(`💰 **Remaining: $${info.limit_remaining.toFixed(4)}**`);
        }

        lines.push("");

        if (info.is_free_tier) lines.push("Tier: Free");

        if (info.limit !== null && info.limit !== undefined) {
          const limitStr = `$${info.limit.toFixed(2)}`;
          const resetStr = info.limit_reset ? ` (resets ${info.limit_reset})` : "";
          lines.push(`Spend limit: ${limitStr}${resetStr}`);
        }

        if (info.usage_daily !== undefined || info.usage_monthly !== undefined) {
          lines.push("");
          lines.push("**Usage**");
          if (info.usage_daily !== undefined) {
            lines.push(`  Today: $${info.usage_daily.toFixed(4)}`);
          }
          if (info.usage_monthly !== undefined) {
            lines.push(`  This month: $${info.usage_monthly.toFixed(4)}`);
          }
          if (info.usage !== undefined) {
            lines.push(`  All-time: $${info.usage.toFixed(4)}`);
          }
        }

        emitMessage(pi, lines.join("\n"));
      } catch (err: any) {
        ctx.ui.notify(`Balance check failed: ${err?.message}`, "error");
      }
    },
  });

  pi.registerCommand("openrouter-status", {
    description: "Show current extension state: synced models, active enrichments, cache age",
    handler: async (_args, _ctx) => {
      const snapshot = getSnapshot();
      const lines: string[] = ["**OpenRouter Extension Status**", ""];

      const totalModels = snapshot.models.length;
      const variantCount = snapshot.routes.size;
      const baseModelCount = Math.max(0, totalModels - variantCount);

      lines.push(`Models registered: ${totalModels}`);
      lines.push(`Base models: ${baseModelCount}`);
      lines.push(`Variants registered: ${variantCount}`);

      if (snapshot.enrichedModelIds.size > 0) {
        lines.push(`Enriched models: ${Array.from(snapshot.enrichedModelIds).join(", ")}`);
      } else {
        lines.push("Enriched models: none");
      }

      if (snapshot.timestamp > 0) {
        const ageMin = Math.round((Date.now() - snapshot.timestamp) / 60000);
        lines.push(`Last sync: ${ageMin} minute(s) ago`);
      } else {
        lines.push("Last sync: never");
      }

      emitMessage(pi, lines.join("\n"));
    },
  });

  // ---------- Status bar ----------

  function updateStatusBar(ctx: any) {
    const snapshot = getSnapshot();
    if (snapshot.models.length > 0) {
      const variantCount = snapshot.routes.size;
      const enrichLabel = variantCount > 0 ? ` (${variantCount} variants)` : "";
      try {
        ctx.ui.setStatus("openrouter", `OR: ${snapshot.models.length} models${enrichLabel}`);
      } catch {
        // setStatus may not be available in all UI modes
      }
    }
  }
}
