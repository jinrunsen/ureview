import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { connectRepository, listRepositories, type RepositorySummary } from "./api";
import { useSession } from "./auth";
import { Icon } from "./icons";
import { AppHeader, formatDate } from "./layout";
import "./repositories.css";

type ListStatus = "loading" | "ready" | "error";
type Feedback = { kind: "success" | "duplicate" | "error"; message: string; repository?: RepositorySummary };
const permissionNotice = "只读接入，不会向 GitLab 写入任何内容";

export function RepositoriesPage() {
  const { user } = useSession();
  const isAdmin = user?.role === "admin";
  const connectTab = new URLSearchParams(window.location.search).get("tab") === "connect";
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [listStatus, setListStatus] = useState<ListStatus>("loading");
  const [listError, setListError] = useState("");
  const [search, setSearch] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const pendingSubmission = useRef(false);
  const latestListRequest = useRef(0);
  const mounted = useRef(true);
  const feedbackElement = useRef<HTMLDivElement>(null);

  const refreshRepositories = useCallback(async () => {
    const requestId = ++latestListRequest.current;
    setListStatus("loading"); setListError("");
    try {
      const result = await listRepositories();
      if (requestId !== latestListRequest.current || !mounted.current) return;
      setRepositories(result.repositories);
      setListStatus("ready");
    } catch (error) {
      if (requestId !== latestListRequest.current || !mounted.current) return;
      setListError(error instanceof Error ? error.message : "仓库列表加载失败，请重试。");
      setListStatus("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refreshRepositories();
    return () => { mounted.current = false; ++latestListRequest.current; };
  }, [refreshRepositories]);
  useEffect(() => { if (feedback) feedbackElement.current?.focus(); }, [feedback]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingSubmission.current || !isAdmin) return;
    pendingSubmission.current = true;
    setSubmitting(true); setFeedback(null);
    const input = { instanceUrl: instanceUrl.trim(), projectPath: projectPath.trim(), token };
    setToken("");
    try {
      const result = await connectRepository(input);
      if (!mounted.current) return;
      setRepositories((current) => [result.repository, ...current.filter((repository) => repository.id !== result.repository.id)]);
      setFeedback({ kind: result.created ? "success" : "duplicate", repository: result.repository,
        message: result.created ? `已接入 ${result.repository.pathWithNamespace}，API 与 Git 读取验证通过。`
          : `${result.repository.pathWithNamespace} 已接入，保留已有凭据和验证时间。` });
      void refreshRepositories();
    } catch (error) {
      if (mounted.current) setFeedback({ kind: "error", message: error instanceof Error ? error.message : "接入失败，请重试。" });
    } finally {
      pendingSubmission.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  const query = search.trim().toLocaleLowerCase();
  const filtered = repositories.filter((repository) => !query || `${repository.name} ${repository.pathWithNamespace} ${repository.instanceUrl}`.toLocaleLowerCase().includes(query));

  return <><AppHeader currentPage="仓库" /><main className="repositories-page">
    <div className="page-title-row"><div><h1>代码仓库</h1><p className="page-description">管理当前团队的 GitLab 连接，查看仓库中的评审与规范。</p></div>
      {!connectTab && isAdmin && <a className="button primary-button" href="/?repositories=1&tab=connect"><Icon name="plus" size={16} />接入仓库</a>}
    </div>
    <nav className="page-tabs" aria-label="仓库页面"><a href="/?repositories=1" aria-current={!connectTab ? "page" : undefined}>已接入仓库{listStatus === "ready" && <span className="repositories-tab-count">{repositories.length}</span>}</a>
      {isAdmin && <a href="/?repositories=1&tab=connect" aria-current={connectTab ? "page" : undefined}>接入仓库</a>}
    </nav>
    {connectTab ? !isAdmin ? <section className="repositories-surface repositories-access-notice"><Icon name="repository" size={28} /><h2>接入仓库需要管理员权限</h2><p>你可以查看当前团队已接入的仓库、评审与规范。</p><a className="button secondary-button" href="/?repositories=1">查看已接入仓库</a></section> :
      <div className="repository-connect-layout"><section className="repositories-surface repository-connect-form" aria-labelledby="connection-heading">
        <div className="repository-connect-heading"><span className="repository-provider-icon"><Icon name="git" size={24} /></span><div><h2 id="connection-heading">连接 GitLab 仓库</h2><p>提供实例地址、仓库路径和只读令牌。</p></div></div>
        <form onSubmit={(event) => void handleSubmit(event)} aria-busy={submitting}>
          <fieldset disabled={submitting}>
            <div className="field"><label htmlFor="instance-url">GitLab 实例地址</label><input id="instance-url" name="instanceUrl" type="url" placeholder="https://gitlab.example.com" autoComplete="url" autoCapitalize="none" spellCheck={false} required maxLength={2048} value={instanceUrl} onChange={(event) => setInstanceUrl(event.target.value)} aria-describedby="instance-hint" /><p id="instance-hint" className="field-hint">使用实例首页地址，可包含部署子路径。</p></div>
            <div className="field"><label htmlFor="project-path">仓库路径或项目 ID</label><input id="project-path" name="projectPath" type="text" placeholder="group/project 或 123" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={1024} value={projectPath} onChange={(event) => setProjectPath(event.target.value)} aria-describedby="project-hint" /><p id="project-hint" className="field-hint">填写包含群组的完整路径，或 GitLab 项目数字 ID。</p></div>
            <div className="field"><label htmlFor="access-token">只读访问令牌</label><input id="access-token" name="token" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={4096} value={token} onChange={(event) => setToken(event.target.value)} aria-describedby="token-hint token-storage-hint" /><p id="token-hint" className="field-hint">使用个人访问令牌（PAT），包括服务账号的 PAT。仅勾选 <code>read_api</code> 和 <code>read_repository</code>。</p><p id="token-storage-hint" className="field-hint">令牌在服务端加密保存，提交后清空输入框。</p></div>
          </fieldset>
          <div className="repository-connect-submit"><button className="button primary-button" type="submit" disabled={submitting}>{submitting ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={16} />}{submitting ? "正在验证…" : "验证并接入"}</button><a className="button secondary-button" href="/?repositories=1">返回仓库列表</a></div>
          <p className="repository-submit-hint" role="status" aria-live="polite">{submitting ? "正在验证 API 与 Git 读取权限，请稍候。" : "接入时验证 API 与 Git 读取权限。"}</p>
          {feedback && <div ref={feedbackElement} className={`feedback ${feedback.kind === "error" ? "feedback-error" : ""}`} role={feedback.kind === "error" ? "alert" : "status"} tabIndex={-1}>
            <strong>{feedback.kind === "error" ? "接入未完成" : feedback.kind === "duplicate" ? "仓库已接入" : "接入成功"}</strong><p>{feedback.message}</p>
            {feedback.kind === "error" && <p>令牌输入已清空，重试时请重新填写。</p>}
            {feedback.repository && <a className="repository-feedback-link" href={`/?repository=${encodeURIComponent(feedback.repository.id)}`}>查看仓库<Icon name="arrow-right" size={14} /></a>}
          </div>}
        </form>
      </section><aside className="repository-connect-aside">
        <section className="repositories-surface repository-readonly-card"><span className="repository-note-icon"><Icon name="check" size={22} /></span><h2>只读连接</h2><p>{permissionNotice}。</p><ul><li>读取 PR 信息、差异与代码文件</li><li>评审与讨论保存在 uReview</li><li>重复接入保留已有凭据和验证时间</li></ul></section>
        <section className="repository-next-steps"><h3>接入后可以做什么</h3><a href="/?rules=1"><Icon name="rules" size={17} /><span>查看仓库规范与历史候选</span><Icon name="chevron-right" size={15} /></a><p>接入后，可通过页头发起评审，在仓库详情页查看 webhook 配置。</p></section>
      </aside></div>
      : <section className="repositories-surface repository-table-section" aria-label="已接入仓库">
        <div className="toolbar repository-toolbar"><div className="search-field"><Icon name="search" size={16} /><input aria-label="搜索仓库" type="search" placeholder="搜索仓库、群组或实例" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="repository-toolbar-right"><span className="table-secondary">{listStatus === "loading" && repositories.length === 0 ? "读取中…" : query ? `${filtered.length} / ${repositories.length} 个仓库` : `${repositories.length} 个仓库`}</span><button className="button secondary-button" type="button" disabled={listStatus === "loading" || submitting} onClick={() => void refreshRepositories()}><Icon name="refresh" size={15} />刷新</button></div>
        </div>
        <div aria-busy={listStatus === "loading"}>
          {listStatus === "loading" && repositories.length === 0 && <p className="repositories-loading" role="status">正在读取仓库…</p>}
          {listStatus === "error" && <div className="repository-list-error" role="alert"><strong>仓库列表加载失败</strong><p>{listError}</p><button className="button secondary-button" type="button" onClick={() => void refreshRepositories()}>重试</button></div>}
          {listStatus === "ready" && repositories.length === 0 && <div className="empty-state"><Icon name="repository" size={30} /><h3>还没有接入仓库</h3><p>{isAdmin ? "连接第一个 GitLab 仓库，开始评审代码。" : "请联系团队管理员接入 GitLab 仓库。"}</p>{isAdmin && <a className="button primary-button" href="/?repositories=1&tab=connect"><Icon name="plus" size={15} />接入仓库</a>}</div>}
          {repositories.length > 0 && filtered.length === 0 && <div className="empty-state"><Icon name="search" size={28} /><h3>没有匹配的仓库</h3><p>试试仓库名称、群组路径或 GitLab 实例地址。</p><button className="button secondary-button" type="button" onClick={() => setSearch("")}>清空搜索</button></div>}
          {filtered.length > 0 && <div className="table-scroll"><table className="data-table repository-data-table"><thead><tr><th>仓库</th><th>GitLab 实例</th><th>接入状态</th><th>验证时间</th><th>自动评审</th></tr></thead><tbody>{filtered.map((repository) => <tr key={repository.id} className="repository-row" onClick={(event) => { if (!(event.target instanceof Element && event.target.closest("a"))) window.location.assign(`/?repository=${encodeURIComponent(repository.id)}`); }}>
            <td><div className="repository-name-cell"><span className="repository-table-icon"><Icon name="repository" size={19} /></span><div><a className="table-primary repository-detail-button" href={`/?repository=${encodeURIComponent(repository.id)}`}>{repository.name}</a><div className="table-secondary repository-namespace">{repository.pathWithNamespace}</div></div></div></td>
            <td><span className="repository-instance" title={repository.instanceUrl}>{repository.instanceUrl.replace(/^https?:\/\//, "")}</span></td>
            <td><span className="status-badge repository-verified"><Icon name="check" size={12} />已验证</span></td>
            <td><time className="table-secondary" dateTime={repository.connectedAt}>{formatDate(repository.connectedAt)}</time></td>
            <td><span className="status-badge">{repository.automaticReviewEnabled ? "已开启" : "已关闭"}</span></td>
          </tr>)}</tbody></table></div>}
        </div>
        <div className="repository-table-note"><Icon name="check" size={14} /><p>“已验证”表示接入时通过 API 与 Git 读取验证。{permissionNotice}。</p></div>
      </section>}
  </main></>;
}
