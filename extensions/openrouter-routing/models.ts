import { getModels } from "@earendil-works/pi-ai";
import {
  ENRICHED_MODEL_PREFIX,
  ENDPOINT_STATUS_LABELS,
  type OpenRouterModel,
  type OpenRouterEndpoint,
  type OpenRouterArchitecture,
  type ProviderModelConfig,
  type RouteVariant,
  type EndpointGroup,
  type EnrichedResult,
  type InputType,
} from "./types.js";
import { fetchModelEndpoints } from "./api.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------- Reasoning detection ----------

const REASONING_ID_PATTERNS = [
  ":thinking",
  "-r1",
  "/r1",
  "o1-",
  "o3-",
  "o4-",
  "reasoner",
  "-thinking",
  "qwq-",
  "/qwq",
];

const REASONING_NAME_PATTERNS = ["thinking", "reasoner", "chain-of-thought"];

const REASONING_SUPPORTED_PARAMETERS = new Set([
  "include_reasoning",
  "reasoning",
  "reasoning_effort",
]);

function supportsReasoningParameter(supportedParameters?: string[]): boolean {
  return supportedParameters?.some((p) => REASONING_SUPPORTED_PARAMETERS.has(p)) ?? false;
}

function hasReasoningDefaults(defaultParameters?: Record<string, unknown>): boolean {
  return (
    defaultParameters?.include_reasoning !== undefined ||
    defaultParameters?.reasoning !== undefined ||
    defaultParameters?.reasoning_effort !== undefined
  );
}

function matchesReasoningNameHeuristic(id: string, name?: string): boolean {
  const normalizedId = id.toLowerCase();
  const normalizedName = (name || "").toLowerCase();
  return (
    REASONING_ID_PATTERNS.some((p) => normalizedId.includes(p)) ||
    REASONING_NAME_PATTERNS.some((p) => normalizedName.includes(p))
  );
}

export function isReasoningModel(m: OpenRouterModel): boolean {
  return (
    supportsReasoningParameter(m.supported_parameters) ||
    hasReasoningDefaults(m.default_parameters) ||
    matchesReasoningNameHeuristic(m.id, m.name)
  );
}

function isReasoningEndpoint(endpoint: OpenRouterEndpoint): boolean | undefined {
  if (!endpoint.supported_parameters) return undefined;
  return supportsReasoningParameter(endpoint.supported_parameters);
}

// ---------- Input modality ----------

export function supportsImages(architecture?: OpenRouterArchitecture): boolean {
  if (architecture?.input_modalities) {
    return architecture.input_modalities.includes("image");
  }
  return architecture?.modality?.includes("multimodal") ?? false;
}

// ---------- Cost parsing (fixed: missing ≠ zero) ----------

export function parseCost(value?: string): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  // OpenRouter: price per token → pi expects per million tokens
  return n * 1_000_000;
}

function costOrFallback(value: number | undefined, fallback: number): number {
  return value !== undefined ? value : fallback;
}

function maxDefined(values: Array<number | undefined>, fallback: number): number {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length > 0 ? Math.max(...defined) : fallback;
}

function minPositive(values: Array<number | undefined>, fallback: number): number {
  const filtered = values.filter((v): v is number => typeof v === "number" && v > 0);
  return filtered.length > 0 ? Math.min(...filtered) : fallback;
}

// ---------- Model conversion ----------

const BUILTIN_OPENROUTER_MODELS = new Map(getModels("openrouter").map((model) => [model.id, model]));

// --- Respect models.json `modelOverrides` for openrouter -----------------
// This extension re-registers the whole OpenRouter provider from the live
// catalog, which would otherwise drop the user's models.json per-model
// overrides (compat.openRouterRouting, contextWindow, ...). Load them once
// and re-apply on top of every synced model so the override stays effective.
// Mirrored from pi-coding-agent's utils/json.js — keep byte-identical so JSONC
// (// comments + trailing commas) parses exactly like pi's own models.json loader.
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function loadModelOverrides(): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  try {
    const path = join(getAgentDir(), "models.json");
    if (!existsSync(path)) return map;
    const cfg = JSON.parse(stripJsonComments(readFileSync(path, "utf-8")));
    const overrides = cfg?.providers?.openrouter?.modelOverrides;
    if (overrides && typeof overrides === "object") {
      for (const [id, ov] of Object.entries(overrides as Record<string, unknown>)) {
        if (ov && typeof ov === "object") map.set(id, ov as Record<string, unknown>);
      }
    }
  } catch (err) {
    // Malformed models.json — fall back to no overrides, but surface the
    // failure so it's diagnosable (a silently-empty map was the original bug).
    console.warn(
      `[pi-openrouter-realtime] failed to load models.json overrides: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return map;
}

const MODEL_OVERRIDES = loadModelOverrides();

function applyUserOverride(model: ProviderModelConfig): ProviderModelConfig {
  const ov = MODEL_OVERRIDES.get(model.id);
  if (!ov) return model;

  const merged: ProviderModelConfig = { ...model };

  if (ov.contextWindow !== undefined) merged.contextWindow = ov.contextWindow as number;
  if (ov.maxTokens !== undefined) merged.maxTokens = ov.maxTokens as number;
  if (ov.name !== undefined) merged.name = ov.name as string;
  if (ov.reasoning !== undefined) merged.reasoning = ov.reasoning as boolean;
  if (ov.input !== undefined) merged.input = ov.input as ProviderModelConfig["input"];
  if (ov.thinkingLevelMap) {
    merged.thinkingLevelMap = { ...(merged.thinkingLevelMap ?? {}), ...(ov.thinkingLevelMap as object) };
  }
  if (ov.headers) merged.headers = { ...(merged.headers ?? {}), ...(ov.headers as object) };
  if (ov.cost) {
    merged.cost = {
      ...merged.cost,
      ...(ov.cost as object),
    };
  }
  if (ov.compat) {
    merged.compat = {
      ...((merged.compat ?? {}) as Record<string, unknown>),
      ...((ov.compat ?? {}) as Record<string, unknown>),
    } as ProviderModelConfig["compat"];
  }

  return merged;
}

function applyBuiltinOpenRouterMetadata(model: ProviderModelConfig): ProviderModelConfig {
  const builtin = BUILTIN_OPENROUTER_MODELS.get(model.id);
  if (!builtin) return applyUserOverride(model);

  const merged: ProviderModelConfig = {
    ...model,
    api: model.api ?? builtin.api,
    baseUrl: model.baseUrl ?? builtin.baseUrl,
    reasoning: model.reasoning || builtin.reasoning,
  };

  if (builtin.thinkingLevelMap || model.thinkingLevelMap) {
    merged.thinkingLevelMap = {
      ...(builtin.thinkingLevelMap ?? {}),
      ...(model.thinkingLevelMap ?? {}),
    };
  }

  if (builtin.headers || model.headers) {
    merged.headers = {
      ...(builtin.headers ?? {}),
      ...(model.headers ?? {}),
    };
  }

  if (builtin.compat || model.compat) {
    merged.compat = {
      ...((builtin.compat ?? {}) as Record<string, unknown>),
      ...((model.compat ?? {}) as Record<string, unknown>),
    } as ProviderModelConfig["compat"];
  }

  return applyUserOverride(merged);
}

export function toProviderModel(m: OpenRouterModel): ProviderModelConfig {
  return applyBuiltinOpenRouterMetadata({
    id: m.id,
    name: m.name || m.id,
    reasoning: isReasoningModel(m),
    input: supportsImages(m.architecture) ? (["text", "image"] as InputType[]) : (["text"] as InputType[]),
    cost: {
      input: costOrFallback(parseCost(m.pricing?.prompt), 0),
      output: costOrFallback(parseCost(m.pricing?.completion), 0),
      cacheRead: costOrFallback(parseCost(m.pricing?.input_cache_read), 0),
      cacheWrite: costOrFallback(parseCost(m.pricing?.input_cache_write), 0),
    },
    contextWindow: m.context_length || 128000,
    maxTokens: m.top_provider?.max_completion_tokens || 16384,
  });
}

// ---------- Variant ID / name creation ----------

export function slugifyProvider(value?: string): string {
  return (
    (value || "unknown-provider")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown-provider"
  );
}

function getProviderSlug(endpoint: OpenRouterEndpoint): string {
  const fromTag = endpoint.tag?.split("/")[0]?.trim().toLowerCase();
  return fromTag || slugifyProvider(endpoint.provider_name);
}

export function createVariantId(baseModelId: string, providerSlug: string, quantization?: string): string {
  const routeLabel = quantization ? `${providerSlug}:${quantization.toLowerCase()}` : providerSlug;
  return `${ENRICHED_MODEL_PREFIX}${routeLabel}:${baseModelId}`;
}

function createVariantName(baseName: string, providerName: string, quantization?: string): string {
  return quantization ? `${providerName} · ${quantization} — ${baseName}` : `${providerName} — ${baseName}`;
}

// ---------- Endpoint grouping ----------

function normalizeQuantizationForGrouping(value?: string): string | undefined {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized || normalized === "unknown") return undefined;
  return normalized;
}

export function groupEndpoints(
  base: OpenRouterModel,
  endpoints: OpenRouterEndpoint[],
): EndpointGroup[] {
  const groups = new Map<string, EndpointGroup>();

  for (const endpoint of endpoints) {
    const providerSlug = getProviderSlug(endpoint);
    const providerName = endpoint.provider_name || providerSlug;
    const quantizationNorm = normalizeQuantizationForGrouping(endpoint.quantization);
    const quantizationRaw = endpoint.quantization?.trim() || undefined;
    const syntheticId = createVariantId(base.id, providerSlug, quantizationNorm);
    const key = `${providerSlug}::${quantizationNorm || "default"}`;

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
          quantization: quantizationNorm,
          quantizationRaw,
        },
        endpoints: [endpoint],
      });
    }
  }

  // Compute health stats from the best endpoint in each group
  for (const group of groups.values()) {
    const best = group.endpoints.reduce((a, b) => {
      const aStatus = a.status ?? -99;
      const bStatus = b.status ?? -99;
      return bStatus > aStatus ? b : a;
    });
    group.route.endpointStatus = best.status ?? undefined;
    group.route.uptimePct = best.uptime_last_30m ?? undefined;
    group.route.latencyP50 = best.latency_last_30m?.p50 ?? undefined;
    group.route.throughputP50 = best.throughput_last_30m?.p50 ?? undefined;
    group.route.supportsCaching = group.endpoints.some((e) => e.supports_implicit_caching);
  }

  return Array.from(groups.values()).sort((a, b) => {
    const providerCompare = a.route.providerName.localeCompare(b.route.providerName);
    if (providerCompare !== 0) return providerCompare;
    return (a.route.quantization || "").localeCompare(b.route.quantization || "");
  });
}

// ---------- Variant model building ----------

function buildVariantModel(
  base: OpenRouterModel,
  route: RouteVariant,
  endpoints: OpenRouterEndpoint[],
): ProviderModelConfig {
  const fallback = toProviderModel(base);
  const endpointReasoning = endpoints
    .map(isReasoningEndpoint)
    .filter((value): value is boolean => value !== undefined);

  return {
    id: route.syntheticId,
    name: createVariantName(fallback.name, route.providerName, route.quantization),
    api: fallback.api,
    baseUrl: fallback.baseUrl,
    reasoning: endpointReasoning.length > 0 ? endpointReasoning.some(Boolean) : fallback.reasoning,
    thinkingLevelMap: fallback.thinkingLevelMap,
    input: fallback.input,
    cost: {
      input: maxDefined(
        endpoints.map((e) => parseCost(e.pricing?.prompt)),
        fallback.cost.input,
      ),
      output: maxDefined(
        endpoints.map((e) => parseCost(e.pricing?.completion)),
        fallback.cost.output,
      ),
      cacheRead: maxDefined(
        endpoints.map((e) => parseCost(e.pricing?.input_cache_read)),
        fallback.cost.cacheRead,
      ),
      cacheWrite: maxDefined(
        endpoints.map((e) => parseCost(e.pricing?.input_cache_write)),
        fallback.cost.cacheWrite,
      ),
    },
    contextWindow: minPositive(
      endpoints.map((e) => e.context_length),
      fallback.contextWindow,
    ),
    maxTokens: minPositive(
      endpoints.map((e) => e.max_completion_tokens),
      fallback.maxTokens,
    ),
    headers: fallback.headers,
    compat: fallback.compat,
  };
}

// ---------- Enrichment for a single model ----------

export async function enrichModel(
  models: OpenRouterModel[],
  targetModelId: string,
  apiKey?: string,
): Promise<EnrichedResult> {
  const targetModel = models.find((m) => m.id === targetModelId);
  if (!targetModel) {
    throw new Error(`OpenRouter model not found: ${targetModelId}`);
  }

  const variants: ProviderModelConfig[] = [];
  const routes = new Map<string, RouteVariant>();
  let endpointFailures = 0;

  try {
    const endpoints = await fetchModelEndpoints(targetModel.id, apiKey);
    for (const group of groupEndpoints(targetModel, endpoints)) {
      variants.push(buildVariantModel(targetModel, group.route, group.endpoints));
      routes.set(group.route.syntheticId, group.route);
    }
  } catch {
    endpointFailures = 1;
  }

  return { variants, routes, variantCount: variants.length, endpointFailures };
}

// ---------- Format helpers ----------

export function formatEndpointHealth(route: RouteVariant): string {
  const parts: string[] = [];

  if (route.endpointStatus != null) {
    parts.push(ENDPOINT_STATUS_LABELS[route.endpointStatus] || `status: ${route.endpointStatus}`);
  }
  if (route.uptimePct != null) {
    parts.push(`uptime: ${route.uptimePct.toFixed(0)}%`);
  }
  if (route.latencyP50 != null) {
    parts.push(`TTFT: ${route.latencyP50.toFixed(0)}ms`);
  }
  if (route.throughputP50 != null) {
    parts.push(`${route.throughputP50.toFixed(0)} tok/s`);
  }
  if (route.supportsCaching) {
    parts.push("📦 caching");
  }

  return parts.length > 0 ? parts.join(" · ") : "no health data";
}
