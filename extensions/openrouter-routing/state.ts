import type {
  ProviderModelConfig,
  RouteVariant,
  SyncSnapshot,
} from "./types.js";
import { toProviderModel, enrichModel } from "./models.js";
import { fetchModels, getCachedModels } from "./api.js";
import type { OpenRouterModel } from "./types.js";

let currentSnapshot: SyncSnapshot = {
  generation: 0,
  models: [],
  routes: new Map(),
  enrichedModelIds: new Set(),
  timestamp: 0,
};

let syncGeneration = 0;

export function getSnapshot(): SyncSnapshot {
  return currentSnapshot;
}

export function getGeneration(): number {
  return syncGeneration;
}

export function nextGeneration(): number {
  return ++syncGeneration;
}

export function isStale(generation: number): boolean {
  return generation !== syncGeneration;
}

export interface SyncPlainResult {
  models: ProviderModelConfig[];
  routes: ReadonlyMap<string, RouteVariant>;
  modelCount: number;
}

export async function buildPlainSync(apiKey?: string, force?: boolean): Promise<SyncPlainResult> {
  const rawModels = await fetchModels(apiKey, force);
  const models = rawModels.map(toProviderModel);
  return {
    models,
    routes: new Map(),
    modelCount: models.length,
  };
}

export interface SyncEnrichResult {
  models: ProviderModelConfig[];
  routes: ReadonlyMap<string, RouteVariant>;
  enrichedModelIds: Set<string>;
  modelCount: number;
  variantCount: number;
  endpointFailures: number;
}

export async function buildEnrichedSync(
  targetModelId: string,
  apiKey?: string,
  force?: boolean,
): Promise<SyncEnrichResult> {
  const rawModels = await fetchModels(apiKey, force);
  const baseModels = rawModels.map(toProviderModel);

  const routes = new Map<string, RouteVariant>();
  const enrichedModelIds = new Set<string>();

  const enriched = await enrichModel(rawModels, targetModelId, apiKey);
  enrichedModelIds.add(targetModelId);

  for (const [key, route] of enriched.routes) {
    routes.set(key, route);
  }

  return {
    models: [...baseModels, ...enriched.variants],
    routes,
    enrichedModelIds,
    modelCount: baseModels.length,
    variantCount: routes.size,
    endpointFailures: enriched.endpointFailures,
  };
}

export function commitSnapshot(
  generation: number,
  models: ProviderModelConfig[],
  routes: ReadonlyMap<string, RouteVariant>,
  enrichedModelIds?: Set<string>,
): boolean {
  if (isStale(generation)) return false;
  currentSnapshot = {
    generation,
    models,
    routes,
    enrichedModelIds: enrichedModelIds || new Set(),
    timestamp: Date.now(),
  };
  return true;
}

export function getCachedModelList(): OpenRouterModel[] | null {
  return getCachedModels();
}
