import { describe, expect, it } from "vitest";
import { parseGitLabReviewUrl } from "./url.js";

describe("GitLab 评审链接", () => {
  it.each(["", "/", "/diffs", "/commits", "/pipelines", "/activity/"])("接受 MR 链接与标准子页面 %s", (suffix) => {
    expect(parseGitLabReviewUrl(`https://gitlab.example.test/gitlab/team/subgroup/payment/-/merge_requests/17${suffix}?diff_id=2#note_3`))
      .toEqual({ origin: "https://gitlab.example.test", repositoryPath: "gitlab/team/subgroup/payment", iid: 17 });
  });

  it("规范化主机、默认端口和路径编码，保留自建实例前缀", () => {
    expect(parseGitLabReviewUrl(" https://GITLAB.example.test:443/gitlab/team/%70ayment/-/merge_requests/3 "))
      .toEqual({ origin: "https://gitlab.example.test", repositoryPath: "gitlab/team/payment", iid: 3 });
    expect(parseGitLabReviewUrl("http://gitlab.example.test/team/payment/merge_requests/1")).toEqual({ origin: "http://gitlab.example.test", repositoryPath: "team/payment", iid: 1 });
    expect(parseGitLabReviewUrl("http://localhost:8080/team/payment/-/merge_requests/1").origin).toBe("http://localhost:8080");
  });

  it.each([
    "", "not-a-url", "https://gitlab.example.test/team/payment", "https://github.com/team/payment/pull/1",
    "https://gitlab.example.test/team/payment/-/merge_requests/0", "https://gitlab.example.test/team/payment/-/merge_requests/-1",
    "https://gitlab.example.test/team/payment/-/merge_requests/1.5", "https://gitlab.example.test/team/payment/-/merge_requests/9007199254740992",
    "https://user:password@gitlab.example.test/team/payment/-/merge_requests/1", "ftp://gitlab.example.test/team/payment/-/merge_requests/1",
    "https://gitlab.example.test/team%2Fpayment/repo/-/merge_requests/1", "https://gitlab.example.test/team/%ZZ/-/merge_requests/1",
    "https://gitlab.example.test/team//payment/-/merge_requests/1", "https://gitlab.example.test/team/payment/-/merge_requests/1/edit",
  ])("拒绝不支持或无效的链接 %s", (value) => {
    expect(() => parseGitLabReviewUrl(value)).toThrow(expect.objectContaining({ code: "invalid_pull_request_url" }));
  });
});
