import { Icon } from "./icons";
import type { CatalogLint } from "./rules-api";

export const lintKey = (lint: CatalogLint) => `${lint.file.repositoryId}:${lint.id}`;

export function LintTable({ lints, onSelect }: { lints: CatalogLint[]; onSelect: (lint: CatalogLint) => void }) {
  return <table className="data-table rules-table"><thead><tr><th scope="col">Lint 名称</th><th scope="col">仓库</th><th scope="col">路径条件</th><th scope="col">注册文件</th><th scope="col">执行状态</th></tr></thead>
    <tbody>{lints.map((lint) => <tr key={lintKey(lint)}>
      <td><button className="rule-title-button table-primary" onClick={() => onSelect(lint)}>{lint.name}<Icon name="chevron-right" size={15} /></button><p className="table-secondary rule-table-description">{lint.description}</p></td>
      <td>{lint.file.repositoryName}<div className="table-secondary">{lint.checkerRoot || "仓库根目录"}</div></td>
      <td>{lint.paths.map((path) => <div key={path}><code>{path}</code></div>)}</td>
      <td><a className="rule-file-link" href={lint.file.url} target="_blank" rel="noreferrer">{lint.file.path}<Icon name="arrow-up-right" size={13} /></a></td>
      <td><span className="status-badge">未执行</span></td>
    </tr>)}</tbody>
  </table>;
}

export function LintDetail({ lint }: { lint: CatalogLint }) {
  return <div className="rule-detail">
    <div className="rule-detail-tags"><span className="status-badge">仓库 Lint</span><span className="status-badge">未执行</span></div>
    <p className="rule-body">{lint.description || "此检查未填写说明。"}</p>
    <p className="rule-notice">这里只同步检查配置。uReview 的只读评审不会运行仓库中的 lint 脚本。</p>
    <section><h3>检查配置</h3><dl className="rule-metadata">
      <div><dt>仓库</dt><dd>{lint.file.repositoryName}</dd></div>
      <div><dt>匹配基准</dt><dd><code>{lint.checkerRoot || "."}</code>（仓库相对目录）</dd></div>
      <div><dt>路径条件</dt><dd>{lint.paths.map((path) => <code key={path}>{path}</code>)}</dd></div>
      <div><dt>执行脚本</dt><dd><code>{lint.script}</code></dd></div>
      <div><dt>附加参数</dt><dd>{lint.args.length ? lint.args.map((arg, index) => <code key={index}>{arg}</code>) : "无"}</dd></div>
    </dl></section>
    <section><h3>Git 来源</h3><dl className="rule-metadata">
      <div><dt>注册文件</dt><dd><a href={lint.file.url} target="_blank" rel="noreferrer">{lint.file.path}<Icon name="arrow-up-right" size={14} /></a></dd></div>
      <div><dt>提交</dt><dd><code>{lint.file.commitSha}</code></dd></div>
    </dl><details className="rule-markdown"><summary>注册文件源码</summary><pre className="code-block"><code>{lint.body}</code></pre></details></section>
  </div>;
}
