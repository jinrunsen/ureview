import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const head = "a".repeat(40), beforeSha = "b".repeat(40), afterSha = "c".repeat(40);
export const ruleBody = "金额必须先经过正数校验，然后才可以扣款。";

export async function startCatalogGitLab() {
  const state = { currentAfter: "const amount = Math.max(input, 1);\n", publicEmail: "author@example.test", commitEmail: "author@example.test" as string | null,
    requestCount: 0, discussionStatus: 200, discussionPage: false,
    ruleTexts: [ruleBody], pullRequestCount: 2, resolved: false, failedFiles: new Set<string>(), fileModes: {} as Record<string, string>, files: {
    ".agents/rules/payment.md": `---\nname: 金额校验\npaths: [src/**]\n---\n${ruleBody}\n`,
    ".agents/rules/lazy.md": "---\nname: 说明\n---\n没有自动匹配路径的惰性约定。\n",
    ".ureview/global-rules.json": JSON.stringify({ groups: [{ languages: ["go"], rules: [{ id: "G-001", body: "金额使用整数分", source: { kind: "manual" } }] }] }),
  } as Record<string, string> };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    state.requestCount++; requests.push(`${request.method} ${request.url}`);
    const url = new URL(request.url!, "http://fixture");
    let body: unknown;
    if (request.method !== "GET" || request.headers["private-token"] !== "fixture-token") { response.writeHead(403).end(); return; }
    if (url.pathname === "/api/v4/users/42") {
      body = { id: 42, bot: false, public_email: state.publicEmail };
    }
    else if (url.pathname.endsWith("/repository/commits/HEAD")) body = { id: head };
    else if (url.pathname.endsWith("/repository/tree")) body = Object.keys(state.files).map((path) => ({ path, type: "blob", mode: state.fileModes[path] ?? "100644" }));
    else if (url.pathname.includes("/repository/files/")) {
      const path = decodeURIComponent(url.pathname.split("/repository/files/")[1]!);
      if (state.failedFiles.has(path)) { response.writeHead(500).end(); return; }
      const ref = url.searchParams.get("ref")!;
      const content = path === "src/payment.ts" ? ref === beforeSha ? "const amount = input;\n" : state.currentAfter : state.files[path];
      if (content === undefined) { response.writeHead(404).end(); return; }
      body = { encoding: "base64", file_path: path, commit_id: ref, content: Buffer.from(content).toString("base64"),
        content_sha256: createHash("sha256").update(content).digest("hex") };
    } else if (url.pathname.endsWith("/discussions")) {
      if (state.discussionStatus !== 200) { response.writeHead(state.discussionStatus).end("PRIVATE_UPSTREAM_ERROR"); return; }
      const page = Number(url.searchParams.get("page"));
      response.setHeader("x-next-page", state.discussionPage && page === 1 ? "2" : "");
      body = [{ id: `thread-${page}`, notes: state.ruleTexts.map((body, index) => ({ id: page * 100 + index, body: `${body}\n\`\`\`suggestion\nconst amount = Math.max(input, 1);\n\`\`\``,
        author: { id: 7, username: "reviewer", bot: false }, created_at: "2026-01-01T00:00:00Z", system: false, resolved: state.resolved,
        position: { position_type: "text", new_path: "src/payment.ts", head_sha: beforeSha },
        suggestions: [{ from_line: 1, to_line: 1, from_content: "const amount = input;\n", to_content: "const amount = Math.max(input, 1);\n" }] })) }];
    } else if (url.pathname.endsWith("/commits")) body = [{ id: afterSha, parent_ids: [beforeSha], author_email: state.commitEmail, committed_date: "2026-01-02T00:00:00Z" }];
    else if (url.pathname.endsWith("/merge_requests")) body = Array.from({ length: state.pullRequestCount }, (_, index) => index + 1).map((iid) => ({ iid, author: { id: 42 }, title: `支付 ${iid}`, sha: afterSha }));
    else { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { state, requests, instanceUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
