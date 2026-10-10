import { useState } from "react";
import { formatDate } from "./layout";
import { Icon } from "./icons";
import type { Candidate } from "./rules-api";

export function CandidateDetail({ candidate, repositoryName }: { candidate: Candidate; repositoryName: string }) {
  const [copy, setCopy] = useState("");
  async function copyRule() {
    try { await navigator.clipboard.writeText(candidate.markdown); setCopy("已复制规范内容"); }
    catch { setCopy("复制未完成，请展开 Markdown 并选中内容复制"); }
  }
  return <div className="rule-detail">
    <div className="rule-detail-tags"><span className={`status-badge ${candidate.active ? "rule-status-active" : ""}`}>{candidate.active ? "已在 Git 中生效" : "候选"}</span>
      <span className="status-badge">跨 {candidate.evidence.length} 个 PR</span></div>
    <section><h3>候选正文</h3><p className="rule-body">{candidate.body}</p></section>
    <section><h3>复制到仓库</h3><dl className="rule-metadata"><div><dt>仓库</dt><dd>{repositoryName}</dd></div>
      <div><dt>建议文件</dt><dd><code>{candidate.suggestedPath}</code></dd></div>
      <div><dt>发现时间</dt><dd>{formatDate(candidate.createdAt)}</dd></div></dl>
      <p className="muted">在仓库提交此文件后重新同步。同一仓库存在正文相同的规范时，候选显示为已生效。</p>
      <button className="button primary-button" onClick={() => void copyRule()}><Icon name="copy" size={16} />复制规范内容</button>
      {copy && <p className="rule-copy-feedback" role="status">{copy}</p>}
      <details className="rule-markdown"><summary>可复制的 Markdown</summary><textarea readOnly aria-label="可复制的 Markdown" value={candidate.markdown} spellCheck={false} /></details>
    </section>
    <section><h3>原评论与代码改动证据</h3><p className="muted">评论后的提交中，完整文件恰好落实了建议替换。候选由团队管理员审核采纳。</p>
      {candidate.evidence.map((evidence) => <article className="adoption-evidence" key={`${evidence.iid}:${evidence.commentUrl}`}>
        <div className="adoption-links"><a href={evidence.pullRequestUrl} target="_blank" rel="noreferrer">PR !{evidence.iid} <Icon name="arrow-up-right" size={14} /></a>
          <a href={evidence.commentUrl} target="_blank" rel="noreferrer">原评论</a><a href={evidence.commitUrl} target="_blank" rel="noreferrer">采纳提交</a></div>
        <p className="adoption-path"><code>{evidence.path}</code></p>{evidence.author && <p className="muted">提交作者邮箱：{evidence.author}</p>}
        <div className="adoption-code"><div><h4>修改前 · {evidence.beforeSha.slice(0, 8)}</h4><pre className="code-block"><code>{evidence.before}</code></pre></div>
          <div><h4>修改后 · {evidence.afterSha.slice(0, 8)}</h4><pre className="code-block"><code>{evidence.after}</code></pre></div></div>
      </article>)}
    </section>
  </div>;
}
