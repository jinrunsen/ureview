export interface RepositoryAccessInput {
  instanceUrl: string;
  projectPath: string;
  token: string;
}

export interface VerifiedRepository {
  instanceUrl: string;
  projectId: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  httpUrlToRepo: string;
}

export interface RepositoryConnector {
  verify(input: RepositoryAccessInput): Promise<VerifiedRepository>;
}

export class RepositoryAccessError extends Error {
  constructor(
    readonly code: "invalid_input" | "access_denied" | "invalid_scope" | "unavailable" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryAccessError";
  }
}
