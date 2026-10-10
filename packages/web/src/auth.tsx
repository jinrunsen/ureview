import { consumeSsoError } from "./sso-errors";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { addMembership, createMember, createTeam, getMembers, getSession, login, logout, setup, switchTeam, type Member, type Session, type TeamRole } from "./auth-api";
import { AppHeader } from "./layout";
import { Icon } from "./icons";
import { DetailDrawer } from "./ui";
import "./auth.css";
import { IdentityEditor } from "./identity-settings";

const SessionContext = createContext<Session>({ user: null, teams: [], setupRequired: false });
export const useSession = () => useContext(SessionContext);
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试。";

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setSession(await getSession()); setError(""); } catch (cause) { setError(message(cause)); }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => { void refresh(); };
    window.addEventListener("ureview:session-expired", expired);
    return () => window.removeEventListener("ureview:session-expired", expired);
  }, [refresh]);
  if (error) return <main><h1>连接 uReview</h1><p role="alert">{error}</p><button className="button" onClick={() => void refresh()}>重试</button></main>;
  if (!session) return <main><p role="status">正在检查登录状态…</p></main>;
  if (!session.user) return <LoginForm sso={session.sso} initialSetup={session.setupRequired} onSession={setSession} />;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function LoginForm({ initialSetup, onSession, sso }: { sso: Session["sso"]; initialSetup: boolean; onSession: (value: Session) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  useEffect(() => { const message = consumeSsoError(); if (message) setError(message); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError("");
    try {
      const username = String(data.get("username"));
      const password = String(data.get("password"));
      const result = initialSetup
        ? await setup({ token: String(data.get("token")), name: String(data.get("name")), username, email: String(data.get("email") ?? "").trim() || null, password })
        : await login({ username, password });
      form.reset(); onSession(result);
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <main className="auth-page"><a className="brand" href="/">uReview</a><section className="panel auth-panel">
    <h1>{initialSetup ? "创建管理员账号" : "登录 uReview"}</h1>
    <p className="muted">{initialSetup ? "设置第一个账号，已有仓库与评审会保留在默认团队。" : "登录后查看所属团队的仓库、评审与讨论。"}</p>
    {!initialSetup && sso?.enabled && <button type="button" className="button primary-button" onClick={() => window.location.assign(`/api/auth/sso/start?returnTo=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`)}>{sso.buttonLabel}</button>}
    {!initialSetup && sso?.passwordLogin === "service_admin" && <p className="field-hint">密码登录仅供服务管理员使用。</p>}
    <form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}>
      {initialSetup && <><label htmlFor="setup-token">初始化码</label><input id="setup-token" name="token" type="password" required autoComplete="off" />
        <p className="field-hint">初始化码保存在服务器的持久化目录 <code>setup-token</code> 文件中。</p>
        <label htmlFor="account-name">姓名</label><input id="account-name" name="name" required maxLength={100} autoComplete="name" /></>}
      <label htmlFor="account-username">用户名</label><input id="account-username" name="username" required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} pattern={"[^\\s@]+"} aria-describedby="account-username-hint" />
      <p id="account-username-hint" className="field-hint">用户名不区分大小写，不能包含空白或 @。</p>
      {initialSetup && <><label htmlFor="account-email">邮箱（选填）</label><input id="account-email" name="email" type="email" autoComplete="email" maxLength={254} /></>}
      <label htmlFor="account-password">密码</label><div className="password-field"><input id="account-password" name="password" type={passwordVisible ? "text" : "password"} minLength={initialSetup ? 6 : 1} maxLength={initialSetup ? 32 : 128} required autoComplete={initialSetup ? "new-password" : "current-password"} />
        <button className="text-button password-toggle" type="button" aria-label={passwordVisible ? "隐藏密码" : "显示密码"} aria-pressed={passwordVisible} aria-controls="account-password" onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? "隐藏" : "显示"}</button>
      </div>
      {initialSetup && <p className="field-hint">密码需 6–32 个字符。</p>}
      <button className="button primary-button" type="submit" disabled={busy}>{busy ? "正在处理…" : initialSetup ? "创建并登录" : "登录"}</button>
    </fieldset>{error && <p role="alert" className="feedback feedback-error">{error}</p>}</form>
  </section></main>;
}

export function AccountControls() {
  const { user, teams } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const profile = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    profile.current?.querySelector<HTMLAnchorElement>(".account-menu a")?.focus();
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !profile.current?.contains(event.target)) setOpen(false); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", keyboard); };
  }, [open]);
  if (!user) return null;
  async function act(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await operation(); window.location.assign("/?reviews=1"); } catch (cause) { setError(message(cause)); setBusy(false); }
  }
  return <div className="account-controls"><label className="sr-only" htmlFor="active-team">当前团队</label>
    <select id="active-team" value={user.teamId} disabled={busy} onChange={(event) => void act(() => switchTeam(event.target.value))}>
      {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
    </select><div className="account-menu-container" ref={profile} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={toggle} type="button" className="account-profile" aria-label={`${user.name}，账号菜单`} aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)}><span className="avatar">{user.name.slice(0, 1)}</span><span className="account-name">{user.name}</span></button>
      {open && <div id="account-menu" className="account-menu" aria-label="账号菜单"><a href="/?account=1"><Icon name="users" size={16} />我的账号</a><button type="button" disabled={busy} onClick={() => void act(logout)}><Icon name="logout" size={16} />退出登录</button></div>}
    </div>
    {error && <span role="alert">{error}</span>}
  </div>;
}

export function TeamPage() {
  const { user, teams } = useSession();
  const tab = new URLSearchParams(location.search).get("tab") === "teams" ? "teams" : "members";
  const [search, setSearch] = useState("");
  const [drawer, setDrawer] = useState<"member" | "team" | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState(false);
  const [identityMember, setIdentityMember] = useState<Member>();
  const refresh = useCallback(async () => { setLoading(true); try { setMembers((await getMembers()).members); } catch (cause) { setError(message(cause)); } finally { setLoading(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function memberSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, data = new FormData(form);
    setBusy(true); setError(""); setFeedback("");
    try {
      const input = { username: String(data.get("username")), role: String(data.get("role")) as TeamRole };
      if (existing) await addMembership(input);
      else await createMember({ ...input, email: String(data.get("email") ?? "").trim() || null, name: String(data.get("name")), password: String(data.get("password")) });
      form.reset(); await refresh(); setDrawer(null); setFeedback("已加入当前团队。");
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  async function teamSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.currentTarget); setBusy(true); setError("");
    try { const team = await createTeam(String(data.get("teamName"))); await switchTeam(team.id); window.location.assign("/?team=1"); }
    catch (cause) { setError(message(cause)); setBusy(false); }
  }
  const term = search.trim().toLocaleLowerCase();
  const filteredMembers = members.filter((member) => `${member.name} ${member.username} ${member.email ?? ""}`.toLocaleLowerCase().includes(term));
  const filteredTeams = teams.filter((team) => team.name.toLocaleLowerCase().includes(term));
  return <><AppHeader currentPage="成员与团队" /><main className="team-page">
    <div className="page-title-row"><div><p className="eyebrow">{user?.teamName}</p><h1>成员与团队</h1><p className="page-description">一起阅读评审，讨论代码中的问题。</p></div>
      {user?.role === "admin" && <button className="button primary-button" onClick={() => { setError(""); setDrawer(tab === "teams" ? "team" : "member"); }}><Icon name="plus" size={16} />{tab === "teams" ? "创建团队" : "添加成员"}</button>}
    </div>
    <nav className="page-tabs" aria-label="成员与团队页面"><a href="/?team=1" aria-current={tab === "members" ? "page" : undefined}>团队成员 <span className="count">{members.length}</span></a><a href="/?team=1&tab=teams" aria-current={tab === "teams" ? "page" : undefined}>我的团队 <span className="count">{teams.length}</span></a></nav>
    {error && !drawer && <p className="feedback feedback-error" role="alert">{error}</p>}{feedback && <p className="feedback" role="status">{feedback}</p>}
    <section className="panel team-directory"><div className="toolbar"><label className="search-field"><Icon name="search" size={17} /><input aria-label={tab === "teams" ? "搜索团队" : "搜索成员"} type="search" placeholder={tab === "teams" ? "搜索团队名称" : "搜索姓名、用户名或邮箱"} value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="muted">{tab === "teams" ? "你已加入的团队" : "当前团队的成员"}</span></div>
      <div className="table-scroll">{tab === "members" ? <table className="data-table"><thead><tr><th>成员</th><th>用户名</th><th>邮箱</th><th>角色</th><th>所属团队</th>{user?.role === "admin" && <th>身份关联</th>}</tr></thead><tbody>{filteredMembers.map((member) => <tr key={member.id}><td><div className="member-cell"><span className="avatar">{member.name.slice(0, 1)}</span><strong>{member.name}</strong>{member.id === user?.userId && <span className="table-secondary">你</span>}</div></td><td>{member.username}</td><td>{member.email ?? "未填写"}</td><td><span className={`role-badge role-${member.role}`}>{member.role === "admin" ? "管理员" : "成员"}</span></td><td>{user?.teamName}</td>{user?.role === "admin" && <td><button type="button" className="button secondary-button" onClick={() => setIdentityMember(member)}>编辑身份</button></td>}</tr>)}</tbody></table>
        : <table className="data-table"><thead><tr><th>团队</th><th>我的角色</th><th>工作空间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{filteredTeams.map((team) => <tr key={team.id}><td><div className="member-cell"><span className="team-symbol"><Icon name="users" /></span><strong>{team.name}</strong></div></td><td><span className={`role-badge role-${team.role}`}>{team.role === "admin" ? "管理员" : "成员"}</span></td><td>{team.id === user?.teamId ? <span className="status-badge">当前团队</span> : "独立工作空间"}</td><td>{team.id !== user?.teamId && <button className="button secondary-button" disabled={busy} onClick={() => { setBusy(true); void switchTeam(team.id).then(() => location.assign("/?team=1&tab=teams")).catch((cause) => { setError(message(cause)); setBusy(false); }); }}>切换团队<Icon name="arrow-right" size={14} /></button>}</td></tr>)}</tbody></table>}</div>
      {tab === "members" && loading && <p className="list-status" role="status">正在读取团队成员…</p>}
      {!(tab === "members" && (loading || error)) && (tab === "members" ? filteredMembers : filteredTeams).length === 0 && <div className="empty-state"><Icon name="users" size={28} /><h3>{search ? "没有匹配的结果" : "暂无记录"}</h3><p>{search ? tab === "teams" ? "试试其他团队名称。" : "试试其他姓名、用户名或邮箱。" : "加载完成后，团队记录会显示在这里。"}</p></div>}
      <div className="table-footer">{tab === "members" ? `${filteredMembers.length} 位成员 · 成员可阅读、发起评审和参与讨论` : `${filteredTeams.length} 个团队 · 仓库、评审与讨论按团队隔离`}</div>
    </section>
    {identityMember && <DetailDrawer title={`${identityMember.name}的身份关联`} onClose={() => setIdentityMember(undefined)}><IdentityEditor userId={identityMember.id} /></DetailDrawer>}
    {drawer === "member" && <DetailDrawer title="添加团队成员" onClose={() => !busy && setDrawer(null)}><p className="muted">将成员加入「{user?.teamName}」。新账号使用用户名和初始密码登录。</p><div className="team-panel member-editor">
      <label className="checkbox-label"><input type="checkbox" checked={existing} disabled={busy} onChange={(event) => setExisting(event.target.checked)} />使用已有账号</label>
      <form onSubmit={(event) => void memberSubmit(event)}><fieldset disabled={busy}>
        {!existing && <><label htmlFor="member-name">姓名</label><input id="member-name" name="name" required maxLength={100} /></>}
        <label htmlFor="member-username">用户名</label><input id="member-username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} pattern={"[^\\s@]+"} required aria-describedby="member-username-hint" />
        <p id="member-username-hint" className="field-hint">用户名不区分大小写，不能包含空白或 @。</p>
        {!existing && <><label htmlFor="member-email">邮箱（选填）</label><input id="member-email" name="email" type="email" autoComplete="off" maxLength={254} /></>}
        {!existing && <><label htmlFor="member-password">初始密码</label><input id="member-password" name="password" type="password" autoComplete="new-password" minLength={6} maxLength={32} required /><p className="field-hint">6–32 个字符，创建后将账号与密码交给成员。</p></>}
        <label htmlFor="member-role">角色</label><select id="member-role" name="role"><option value="member">成员</option><option value="admin">管理员</option></select>
        <p className="field-hint">管理员还可以接入仓库、管理成员和修改配置。</p>
        <button className="button primary-button" type="submit">{busy ? "正在添加…" : "加入团队"}</button></fieldset>{error && <p role="alert" className="feedback feedback-error">{error}</p>}</form>
    </div></DetailDrawer>}
    {drawer === "team" && <DetailDrawer title="创建团队" onClose={() => !busy && setDrawer(null)}><p className="muted">新团队拥有独立的仓库、评审、规范与讨论。创建后，你将成为该团队的管理员。</p><form className="team-panel member-editor" onSubmit={(event) => void teamSubmit(event)}><fieldset disabled={busy}>
      <label htmlFor="team-name">团队名称</label><input id="team-name" name="teamName" required maxLength={100} /><button className="button primary-button" type="submit">{busy ? "正在创建…" : "创建并切换"}</button>
    </fieldset>{error && <p role="alert" className="feedback feedback-error">{error}</p>}</form></DetailDrawer>}
  </main></>;
}
