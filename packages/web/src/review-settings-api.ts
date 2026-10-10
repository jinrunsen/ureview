import { isRecord, request } from "./api";

export interface ReviewSettings { excludedDirectories: string[]; version: number }

function isReviewSettingsResponse(value: unknown): value is { settings: ReviewSettings } {
  if (!isRecord(value) || !isRecord(value.settings)) return false;
  const settings = value.settings;
  return Number.isSafeInteger(settings.version) && Number(settings.version) >= 0
    && Array.isArray(settings.excludedDirectories) && settings.excludedDirectories.length <= 100
    && settings.excludedDirectories.every((directory: unknown) => typeof directory === "string" && directory.length > 0 && directory.length <= 512);
}

export async function getReviewSettings(repositoryId: string, signal?: AbortSignal): Promise<ReviewSettings> {
  return (await request(`/api/repositories/${encodeURIComponent(repositoryId)}/review-settings`, isReviewSettingsResponse, signal ? { signal } : undefined)).settings;
}

export async function saveReviewSettings(repositoryId: string, settings: ReviewSettings, signal?: AbortSignal): Promise<ReviewSettings> {
  return (await request(`/api/repositories/${encodeURIComponent(repositoryId)}/review-settings`, isReviewSettingsResponse,
    { method: "PUT", body: JSON.stringify(settings), signal })).settings;
}
