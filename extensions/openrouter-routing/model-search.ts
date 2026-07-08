import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { OpenRouterModel } from "./types.js";

function searchableText(model: OpenRouterModel): string {
  const id = model.id;
  const provider = id.split("/")[0] || "openrouter";
  const tokenizedId = id.replace(/[/:_.-]+/g, " ");
  const name = model.name || "";
  return `${id} ${provider} ${provider}/${id} ${provider} ${id} ${tokenizedId} ${name}`;
}

export function sortModels(models: OpenRouterModel[]): OpenRouterModel[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

function queryTokens(query: string): string[] {
  return sanitizeText(query).toLowerCase().split(/\s+/).filter(Boolean);
}

function containsAllTokens(text: string, tokens: string[]): boolean {
  const lower = sanitizeText(text).toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

export function rankModelsForQuery(models: OpenRouterModel[], query: string): OpenRouterModel[] {
  const trimmed = sanitizeText(query);
  if (!trimmed) return sortModels(models);

  const tokens = queryTokens(trimmed);
  const sorted = sortModels(models);

  const exactId = sorted.filter((m) => containsAllTokens(m.id, tokens));
  const exactName = sorted.filter(
    (m) => !exactId.includes(m) && containsAllTokens(m.name || "", tokens),
  );
  const exactTokenizedId = sorted.filter(
    (m) =>
      !exactId.includes(m) &&
      !exactName.includes(m) &&
      containsAllTokens(m.id.replace(/[/:_.-]+/g, " "), tokens),
  );

  const remaining = sorted.filter(
    (m) => !exactId.includes(m) && !exactName.includes(m) && !exactTokenizedId.includes(m),
  );
  const fuzzy = fuzzyFilter(remaining, trimmed, searchableText);

  return [...exactId, ...exactName, ...exactTokenizedId, ...fuzzy];
}

export function sanitizeText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
