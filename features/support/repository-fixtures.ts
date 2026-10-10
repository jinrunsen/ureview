import {
  RepositoryAccessError,
  type RepositoryConnector,
  type VerifiedRepository,
} from "../../packages/server/src/repositories/connector.js";

export const fixtureInstanceUrl = "https://gitlab.example.test";

// 人工协议 fixture，只用于仓库接入，不代表采集过真实 GitLab 实例。
export class RepositoryFixtureConnector implements RepositoryConnector {
  private readonly repositories = new Map<
    string,
    { repository: VerifiedRepository; token: string; readable: boolean }
  >();

  register(name: string, token: string, readable: boolean): void {
    const pathWithNamespace = `commerce/${name}`;
    this.repositories.set(pathWithNamespace, {
      repository: {
        instanceUrl: fixtureInstanceUrl,
        projectId: 1000 + this.repositories.size,
        name,
        pathWithNamespace,
        webUrl: `${fixtureInstanceUrl}/${pathWithNamespace}`,
        httpUrlToRepo: `${fixtureInstanceUrl}/${pathWithNamespace}.git`,
      },
      token,
      readable,
    });
  }

  async verify(input: {
    instanceUrl: string;
    projectPath: string;
    token: string;
  }): Promise<VerifiedRepository> {
    const fixture = this.repositories.get(input.projectPath);
    if (
      input.instanceUrl !== fixtureInstanceUrl ||
      !fixture?.readable ||
      input.token !== fixture.token
    ) {
      throw new RepositoryAccessError(
        "access_denied",
        "令牌无法读取该仓库，请确认令牌范围包含此仓库的只读权限",
      );
    }
    return fixture.repository;
  }
}
