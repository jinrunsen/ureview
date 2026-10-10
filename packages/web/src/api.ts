export interface RepositorySummary {
  id: string;
  instanceUrl: string;
  projectId: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  connectionStatus: "connected";
  connectedAt: string;
  automaticReviewEnabled: boolean;
  automaticReviewVersion: number;
  lastAuthenticationFailureAt: string | null;
}

interface RepositoryList {
  repositories: RepositorySummary[];
  permissionNotice: string;
}

interface ConnectionResult {
  repository: RepositorySummary;
  created: boolean;
  permissionNotice: string;
}

interface ConnectionInput {
  instanceUrl: string;
  projectPath: string;
  token: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
}

export function isRepository(value: unknown): value is RepositorySummary {
  return isRecord(value)
    && ["id", "instanceUrl", "name", "pathWithNamespace", "webUrl", "connectedAt"]
      .every((key) => typeof value[key] === "string")
    && typeof value.projectId === "number"
    && value.connectionStatus === "connected"
    && typeof value.automaticReviewEnabled === "boolean"
    && Number.isSafeInteger(value.automaticReviewVersion) && Number(value.automaticReviewVersion) >= 0
    && (value.lastAuthenticationFailureAt === null || typeof value.lastAuthenticationFailureAt === "string");
}

export async function request<T>(path: string, validate: (body: unknown) => body is T, options?: RequestInit): Promise<T> {
  let response: Response;
  const headers = new Headers(options?.headers);
  headers.set("x-ureview-request", "1");
  if (options?.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  try {
    response = await fetch(path, {
      ...options,
      cache: "no-store",
      headers,
    });
  } catch {
    throw new Error("无法连接 uReview 服务，请检查网络后重试。");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("服务返回了无法识别的响应，请稍后重试。");
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("ureview:session-expired"));
    const error = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
    throw new ApiError(response.status, typeof error?.code === "string" ? error.code : undefined,
      typeof error?.message === "string"
        ? error.message
        : `请求未完成（HTTP ${response.status}），请稍后重试。`,
    );
  }

  if (!validate(body)) {
    throw new Error("服务返回的数据不完整，请稍后重试。");
  }
  return body;
}

export function listRepositories(): Promise<RepositoryList> {
  return request<RepositoryList>(
    "/api/repositories",
    (body): body is RepositoryList => isRecord(body)
      && Array.isArray(body.repositories)
      && body.repositories.every(isRepository)
      && typeof body.permissionNotice === "string",
  );
}

export function connectRepository(input: ConnectionInput): Promise<ConnectionResult> {
  return request<ConnectionResult>(
    "/api/repositories",
    (body): body is ConnectionResult => isRecord(body)
      && isRepository(body.repository)
      && typeof body.created === "boolean"
      && typeof body.permissionNotice === "string",
    { method: "POST", body: JSON.stringify(input) },
  );
}
