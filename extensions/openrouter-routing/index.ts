import {
  streamSimpleOpenAICompletions,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const PROVIDER_NAME = "openrouter";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ENRICHED_MODEL_PREFIX = "openrouter-route:";

type InputType = "text" | "image";
type SyncMode = "plain" | "enriched";

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterArchitecture {
  modality?: string;
  input_modalities?: string[];
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number };
  pricing?: OpenRouterPricing;
  architecture?: OpenRouterArchitecture;
}

interface OpenRouterEndpoint {
  provider_name?: string;
  tag?: string;
  quantization?: string;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: OpenRouterPricing;
}

interface OpenRouterEndpointsResponse {
  data?: {
    endpoints?: OpenRouterEndpoint[];
  };
}

interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: InputType[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

interface RouteVariant {
  syntheticId: string;
  baseModelId: string;
  providerSlug: string;
  providerName: string;
  quantization?: string;
}

interface EnrichedCatalog {
  models: ProviderModelConfig[];
  routes: Map<string, RouteVariant>;
  variantCount: number;
  endpointFailures: number;
}

let cachedModels: OpenRouterModel[] | null = null;
let cacheTimestamp = 0;
let endpointCache = new Map<string, { timestamp: number; endpoints: OpenRouterEndpoint[] }>();
let enrichedRoutes = new Map<string, RouteVariant>();

function isReasoningModel(m: OpenRouterModel): boolean {
  const id = m.id.toLowerCase();
  const name = (m.name || "").toLowerCase();
  return (
    id.includes(":thinking") ||
    id.includes("-r1") ||
    id.includes("/r1") ||
    id.includes("o1-") ||
    id.includes("o3-") ||
    id.includes("o4-") ||
    id.includes("reasoner") ||
    name.includes("thinking") ||
    name.includes("reasoner")
  );
}

function supportsImages(architecture?: OpenRouterArchitecture): boolean {
  if (architecture?.input_modalities) {
    return architecture.input_modalities.includes("image");
  }
  return architecture?.modality?.includes("multimodal") ?? false;
}

function parseCost(value?: string): number {
  const n = parseFloat(value || "0");
  // OpenRouter: price per token → pi expects per million tokens
  return isNaN(n) ? 0 : n * 1_000_000;
}

function normalizeQuantization(value?: string): string | undefined {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return undefined;
  return normalized;
}

function slugifyProvider(value?: string): string {
  return (value || "unknown-provider")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown-provider";
}

function getProviderSlug(endpoint: OpenRouterEndpoint): string {
  const fromTag = endpoint.tag?.split("/")[0]?.trim().toLowerCase();
  return fromTag || slugifyProvider(endpoint.provider_name);
}

function minPositive(values: Array<number | undefined>, fallback: number): number {
  const filtered = values.filter((value): value is number => typeof value === "number" && value > 0);
  return filtered.length > 0 ? Math.min(...filtered) : fallback;
}

function maxValue(values: Array<number | undefined>, fallback: number): number {
  const filtered = values.filter((value): value is number => typeof value === "number" && value >= 0);
  return filtered.length > 0 ? Math.max(...filtered) : fallback;
}

function toProviderModel(m: OpenRouterModel): ProviderModelConfig {
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: isReasoningModel(m),
    input: supportsImages(m.architecture) ? ["text", "image"] : ["text"],
    cost: {
      input: parseCost(m.pricing?.prompt),
      output: parseCost(m.pricing?.completion),
      cacheRead: parseCost(m.pricing?.input_cache_read),
      cacheWrite: parseCost(m.pricing?.input_cache_write),
    },
    contextWindow: m.context_length || 128000,
    maxTokens: m.top_provider?.max_completion_tokens || 16384,
  };
}

function createVariantId(baseModelId: string, providerSlug: string, quantization?: string): string {
  const q = quantization || "default";
  return `${ENRICHED_MODEL_PREFIX}${baseModelId}::${providerSlug}::${q}`;
}

function createVariantName(baseName: string, providerName: string, quantization?: string): string {
  return quantization
    ? `${baseName} (${providerName} · ${quantization})`
    : `${baseName} (${providerName})`;
}

function resetCaches() {
  cachedModels = null;
  cacheTimestamp = 0;
  endpointCache = new Map();
}

async function fetchModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(OPENROUTER_MODELS_URL, { headers });
  if (!res.ok) {
    throw new Error(`OpenRouter API: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data?: OpenRouterModel[] };
  cachedModels = json.data || [];
  cacheTimestamp = now;
  return cachedModels;
}

function buildEndpointsUrl(modelId: string): string {
  const path = modelId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${OPENROUTER_BASE_URL}/models/${path}/endpoints`;
}

async function fetchModelEndpoints(modelId: string, apiKey?: string): Promise<OpenRouterEndpoint[]> {
  const cached = endpointCache.get(modelId);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.endpoints;
  }

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(buildEndpointsUrl(modelId), { headers });
  if (res.status === 404) {
    endpointCache.set(modelId, { timestamp: now, endpoints: [] });
    return [];
  }
  if (!res.ok) {
    throw new Error(`OpenRouter endpoints API: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as OpenRouterEndpointsResponse;
  const endpoints = json.data?.endpoints || [];
  endpointCache.set(modelId, { timestamp: now, endpoints });
  return endpoints;
}

function buildVariantModel(base: OpenRouterModel, route: RouteVariant, endpoints: OpenRouterEndpoint[]): ProviderModelConfig {
  const fallback = toProviderModel(base);

  return {
    id: route.syntheticId,
    name: createVariantName(fallback.name, route.providerName, route.quantization),
    reasoning: fallback.reasoning,
    input: fallback.input,
    cost: {
      input: maxValue(endpoints.map((endpoint) => parseCost(endpoint.pricing?.prompt)), fallback.cost.input),
      output: maxValue(endpoints.map((endpoint) => parseCost(endpoint.pricing?.completion)), fallback.cost.output),
      cacheRead: maxValue(
        endpoints.map((endpoint) => parseCost(endpoint.pricing?.input_cache_read)),
        fallback.cost.cacheRead,
      ),
      cacheWrite: maxValue(
        endpoints.map((endpoint) => parseCost(endpoint.pricing?.input_cache_write)),
        fallback.cost.cacheWrite,
      ),
    },
    contextWindow: minPositive(endpoints.map((endpoint) => endpoint.context_length), fallback.contextWindow),
    maxTokens: minPositive(endpoints.map((endpoint) => endpoint.max_completion_tokens), fallback.maxTokens),
  };
}

function groupEndpoints(base: OpenRouterModel, endpoints: OpenRouterEndpoint[]): Array<{ route: RouteVariant; endpoints: OpenRouterEndpoint[] }> {
  const groups = new Map<string, { route: RouteVariant; endpoints: OpenRouterEndpoint[] }>();

  for (const endpoint of endpoints) {
    const providerSlug = getProviderSlug(endpoint);
    const providerName = endpoint.provider_name || providerSlug;
    const quantization = normalizeQuantization(endpoint.quantization);
    const syntheticId = createVariantId(base.id, providerSlug, quantization);
    const key = `${providerSlug}::${quantization || "default"}`;

    const group = groups.get(key);
    if (group) {
      group.endpoints.push(endpoint);
    } else {
      groups.set(key, {
        route: {
          syntheticId,
          baseModelId: base.id,
          providerSlug,
          providerName,
          quantization,
        },
        endpoints: [endpoint],
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const providerCompare = a.route.providerName.localeCompare(b.route.providerName);
    if (providerCompare !== 0) return providerCompare;
    return (a.route.quantization || "").localeCompare(b.route.quantization || "");
  });
}

async function buildEnrichedCatalog(
  models: OpenRouterModel[],
  targetModelId: string,
  apiKey?: string,
): Promise<EnrichedCatalog> {
  const targetModel = models.find((model) => model.id === targetModelId);
  if (!targetModel) {
    throw new Error(`OpenRouter model not found: ${targetModelId}`);
  }

  const providerModels = models.map(toProviderModel);
  const routes = new Map<string, RouteVariant>();
  let variantCount = 0;
  let endpointFailures = 0;

  try {
    const endpoints = await fetchModelEndpoints(targetModel.id, apiKey);
    for (const group of groupEndpoints(targetModel, endpoints)) {
      providerModels.push(buildVariantModel(targetModel, group.route, group.endpoints));
      routes.set(group.route.syntheticId, group.route);
      variantCount++;
    }
  } catch {
    endpointFailures = 1;
  }

  return { models: providerModels, routes, variantCount, endpointFailures };
}

function streamOpenRouter(
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const route = enrichedRoutes.get(model.id);
  if (!route) {
    return streamSimpleOpenAICompletions(model, context, options);
  }

  return streamSimpleOpenAICompletions(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      let nextPayload = payload;
      if (options?.onPayload) {
        const userPayload = await options.onPayload(payload, payloadModel);
        if (userPayload !== undefined) nextPayload = userPayload;
      }

      if (!nextPayload || typeof nextPayload !== "object" || Array.isArray(nextPayload)) {
        return nextPayload;
      }

      const currentProvider: Record<string, unknown> =
        nextPayload &&
          typeof (nextPayload as { provider?: unknown }).provider === "object" &&
          !Array.isArray((nextPayload as { provider?: unknown }).provider)
          ? { ...((nextPayload as { provider?: Record<string, unknown> }).provider || {}) }
          : {};

      currentProvider.only = [route.providerSlug];
      currentProvider.allow_fallbacks = false;
      if (route.quantization) {
        currentProvider.quantizations = [route.quantization];
      }

      return {
        ...(nextPayload as Record<string, unknown>),
        model: route.baseModelId,
        provider: currentProvider,
      };
    },
  });
}

export default function openrouterModelsExtension(pi: ExtensionAPI) {
  async function syncModels(ctx: any, mode: SyncMode = "plain", silent = false, enrichModelId?: string) {
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
      if (!silent) {
        ctx.ui.notify(
          mode === "plain"
            ? "Fetching OpenRouter models..."
            : `Fetching OpenRouter models and endpoint variants for ${enrichModelId}...`,
          "info",
        );
      }

      const models = await fetchModels(apiKey);
      let providerModels: ProviderModelConfig[];
      let variantCount = 0;
      let endpointFailures = 0;

      if (mode === "enriched") {
        if (!enrichModelId) {
          throw new Error("Missing model id for enrichment");
        }
        const enriched = await buildEnrichedCatalog(models, enrichModelId, apiKey);
        providerModels = enriched.models;
        enrichedRoutes = enriched.routes;
        variantCount = enriched.variantCount;
        endpointFailures = enriched.endpointFailures;
      } else {
        providerModels = models.map(toProviderModel);
        enrichedRoutes = new Map();
      }

      pi.registerProvider(PROVIDER_NAME, {
        baseUrl: OPENROUTER_BASE_URL,
        apiKey: "OPENROUTER_API_KEY",
        api: "openai-completions",
        models: providerModels,
        streamSimple: streamOpenRouter,
      });

      if (!silent) {
        if (mode === "plain") {
          ctx.ui.notify(`OpenRouter: ${providerModels.length} models synced`, "info");
        } else {
          const failuresText = endpointFailures > 0 ? `, ${endpointFailures} endpoint fetch failures` : "";
          ctx.ui.notify(
            `OpenRouter: ${providerModels.length} models synced (${variantCount} provider variants for ${enrichModelId}${failuresText})`,
            "info",
          );
        }
      }
    } catch (err: any) {
      if (!silent) ctx.ui.notify(`OpenRouter sync failed: ${err?.message}`, "error");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.modelRegistry.authStorage.hasAuth(PROVIDER_NAME)) {
      await syncModels(ctx, "plain", true);
    }
  });

  pi.registerCommand("openrouter-sync", {
    description: "Fetch latest OpenRouter base models and restore the plain model list",
    handler: async (_args, ctx) => {
      resetCaches();
      await syncModels(ctx, "plain");
    },
  });

  pi.registerCommand("openrouter-enrich", {
    description: "Fetch OpenRouter endpoint variants for one model and add provider/quantization choices to the model list",
    handler: async (args, ctx) => {
      const modelId = args.trim();
      if (!modelId) {
        ctx.ui.notify("Usage: /openrouter-enrich <openrouter-model-id>", "warning");
        return;
      }
      resetCaches();
      await syncModels(ctx, "enriched", false, modelId);
    },
  });

}
