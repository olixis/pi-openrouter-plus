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

export function isReasoningModel(m: OpenRouterModel): boolean {
  const id = m.id.toLowerCase();
  const name = (m.name || "").toLowerCase();
  return (
    REASONING_ID_PATTERNS.some((p) => id.includes(p)) ||
    REASONING_NAME_PATTERNS.some((p) => name.includes(p))
  );
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

export function toProviderModel(m: OpenRouterModel): ProviderModelConfig {
  return {
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
  };
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

  return {
    id: route.syntheticId,
    name: createVariantName(fallback.name, route.providerName, route.quantization),
    reasoning: fallback.reasoning,
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
