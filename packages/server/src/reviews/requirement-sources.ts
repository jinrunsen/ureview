/** 需求来源快照的一条：PR 标题与描述、一次提交，或 PR 关闭的 issue。 */
export interface RequirementSource {
  id: string;
  kind: "pull_request" | "commit" | "issue";
  title: string;
  description: string;
  url: string | null;
}
