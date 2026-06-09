import {
  OPENROUTER_MODELS_URL,
  OPENROUTER_BASE_URL,
  CACHE_TTL_MS,
  FETCH_TIMEOUT_MS,
  type OpenRouterModel,
  type OpenRouterEndpoint,
  type OpenRouterEndpointsResponse,
  type OpenRouterKeyInfo,
  type OpenRouterCreditsInfo,
  type EndpointCacheEntry,
} from "./types.js";
import { createGunzip, createInflate } from "zlib";

let cachedModels: OpenRouterModel[] | null = null;
let cacheTimestamp = 0;
let cachedApiKeyHash = "";
const endpointCache = new Map<string, EndpointCacheEntry>();

function hashKey(key?: string): string {
  if (!key) return "";
  return key.slice(0, 8) + key.slice(-4);
}

function makeHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

async function decompressResponse(res: Response): Promise<string> {
  const bodyBuffer = Buffer.from(await res.arrayBuffer());

  if (bodyBuffer.length === 0) return "";

  // Decide based on magic bytes ONLY — native fetch auto-decompresses gzip
  // but leaves the Content-Encoding header, so trusting that header causes
  // "incorrect header check" when we gunzip already-decompressed JSON.
  const byte0 = bodyBuffer[0];
  const byte1 = bodyBuffer[1];
  const isGzip = byte0 === 0x1f && byte1 === 0x8b;
  const isDeflate = byte0 === 0x78 && (byte1 === 0x9c || byte1 === 0x01 || byte1 === 0xda);

  if (isGzip) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gunzip = createGunzip();
      gunzip.on("data", (chunk) => chunks.push(chunk));
      gunzip.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      gunzip.on("error", reject);
      gunzip.write(bodyBuffer);
      gunzip.end();
    });
  }

  if (isDeflate) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const inflate = createInflate();
      inflate.on("data", (chunk) => chunks.push(chunk));
      inflate.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      inflate.on("error", reject);
      inflate.write(bodyBuffer);
      inflate.end();
    });
  }

  // Already decompressed (by fetch) or was never compressed
  return bodyBuffer.toString("utf8");
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatFetchError(res: Response, context: string): Error {
  const status = res.status;
  let hint = "";
  if (status === 401 || status === 403) {
    hint = " — check your OpenRouter API key";
  } else if (status === 429) {
    hint = " — rate limited, try again shortly";
  } else if (status >= 500) {
    hint = " — OpenRouter is having issues, try again later";
  }
  return new Error(`${context}: ${status} ${res.statusText}${hint}`);
}

export function invalidateModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}

export function invalidateEndpointCache(modelId?: string): void {
  if (modelId) {
    endpointCache.delete(modelId);
  } else {
    endpointCache.clear();
  }
}

export function invalidateAllCaches(): void {
  invalidateModelCache();
  invalidateEndpointCache();
}

export async function fetchModels(apiKey?: string, force = false): Promise<OpenRouterModel[]> {
  const keyHash = hashKey(apiKey);
  if (keyHash !== cachedApiKeyHash) {
    cachedModels = null;
    cacheTimestamp = 0;
    cachedApiKeyHash = keyHash;
  }

  const now = Date.now();
  if (!force && cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  const res = await fetchWithTimeout(OPENROUTER_MODELS_URL, {
    headers: makeHeaders(apiKey),
  });
  if (!res.ok) throw formatFetchError(res, "OpenRouter models API");

  const bodyText = await decompressResponse(res);
  if (!bodyText || bodyText.trim() === "") {
    throw new Error("OpenRouter models API returned empty response - check network/proxy");
  }

  let json: { data?: OpenRouterModel[] };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(`OpenRouter models API returned invalid JSON (${bodyText.length} bytes received). Response may be HTML or error page - check network/proxy.`);
  }

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

export async function fetchModelEndpoints(
  modelId: string,
  apiKey?: string,
  force = false,
): Promise<OpenRouterEndpoint[]> {
  const cached = endpointCache.get(modelId);
  const now = Date.now();
  if (!force && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.endpoints;
  }

  const res = await fetchWithTimeout(buildEndpointsUrl(modelId), {
    headers: makeHeaders(apiKey),
  });

  if (res.status === 404) {
    endpointCache.set(modelId, { timestamp: now, endpoints: [] });
    return [];
  }
  if (!res.ok) throw formatFetchError(res, "OpenRouter endpoints API");

  const bodyText = await decompressResponse(res);
  if (!bodyText || bodyText.trim() === "") {
    throw new Error("OpenRouter endpoints API returned empty response");
  }

  let json: OpenRouterEndpointsResponse;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(`OpenRouter endpoints API returned invalid JSON (${bodyText.length} bytes received)`);
  }

  const endpoints = json.data?.endpoints || [];
  endpointCache.set(modelId, { timestamp: now, endpoints });
  return endpoints;
}

export async function fetchKeyInfo(apiKey: string): Promise<OpenRouterKeyInfo> {
  const res = await fetchWithTimeout(`${OPENROUTER_BASE_URL}/key`, {
    headers: makeHeaders(apiKey),
  });
  if (!res.ok) throw formatFetchError(res, "OpenRouter key API");

  const bodyText = await decompressResponse(res);
  if (!bodyText || bodyText.trim() === "") {
    return {};
  }

  try {
    const json = JSON.parse(bodyText) as { data?: OpenRouterKeyInfo };
    return json.data || {};
  } catch {
    return {};
  }
}

export async function fetchCredits(apiKey: string): Promise<OpenRouterCreditsInfo | null> {
  try {
    const res = await fetchWithTimeout(`${OPENROUTER_BASE_URL}/credits`, {
      headers: makeHeaders(apiKey),
    });
    if (!res.ok) return null; // requires management key, may fail with regular key
    const bodyText = await decompressResponse(res);
    if (!bodyText || bodyText.trim() === "") return null;
    const json = JSON.parse(bodyText) as { data?: OpenRouterCreditsInfo };
    return json.data || null;
  } catch {
    return null;
  }
}

export function getCachedModels(): OpenRouterModel[] | null {
  return cachedModels;
}
