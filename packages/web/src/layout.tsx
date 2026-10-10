import { useEffect, useRef, useState } from "react";
import { AccountControls, useSession } from "./auth";
import { UnreadIndicator } from "./collaboration";
import { Icon, type IconName } from "./icons";
import { StartReviewDialog } from "./start-review";

const navigation: Array<{ key: string; label: string; href: string; icon: IconName; group: string; access?: "team" | "service" }> = [
  { key: "home", label: "我的待办", href: "/", icon: "home", group: "工作台" },
  { key: "overview", label: "团队概览", href: "/?overview=1", icon: "overview", group: "工作台", access: "team" },
  { key: "reviews", label: "评审", href: "/?reviews=1", icon: "reviews", group: "工作台" },
  { key: "repositories", label: "仓库", href: "/?repositories=1", icon: "repository", group: "代码与规范" },
  { key: "rules", label: "团队规范", href: "/?rules=1", icon: "rules", group: "代码与规范" },
  { key: "team", label: "成员与团队", href: "/?team=1", icon: "users", group: "管理" },
  { key: "team-settings", label: "团队设置", href: "/?team-settings=1", icon: "settings", group: "管理", access: "team" },
  { key: "sessions", label: "运行记录", href: "/?sessions=1", icon: "session", group: "管理", access: "team" },
  { key: "instance", label: "实例管理", href: "/?instance=1", icon: "settings", group: "管理", access: "service" },
];

function activeSection() {
  const params = new URLSearchParams(location.search);
  const section = ["overview", "rules", "team", "team-settings", "instance", "account", "repositories", "sessions"].find((key) => params.get(key) === "1");
  if (section) return section;
  if (params.has("repository") && !params.has("reviews")) return "repositories";
  return params.has("review") || params.has("reviews") ? "reviews" : "home";
}

export function AppHeader({ currentPage }: { currentPage: string }) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const active = activeSection();
  useEffect(() => { document.title = `${currentPage} · uReview`; }, [currentPage]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => sidebar.current?.querySelector<HTMLAnchorElement>('nav a[aria-current="page"]')?.focus());
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); menuButton.current?.focus(); }
      if (event.key !== "Tab") return;
      const links = Array.from(sidebar.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []);
      const first = links[0], last = links.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keyboard);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", keyboard); };
  }, [open]);
  return <>
    <a href="#workspace-content" className="skip-link">跳到页面内容</a>
    {open && <button type="button" className="sidebar-backdrop" aria-label="关闭导航" onClick={() => { setOpen(false); menuButton.current?.focus(); }} />}
    <aside ref={sidebar} id="workspace-navigation" role={open ? "dialog" : undefined} aria-modal={open ? true : undefined} aria-label="工作台导航" className={`app-sidebar${open ? " sidebar-open" : ""}`}>
      <a className="brand" href="/" aria-label="uReview 首页"><span className="brand-mark"><Icon name="git" size={21} /></span><span>uReview<span className="brand-caption">CODE REVIEW</span></span></a>
      <div className="workspace-label"><span className="workspace-dot" /><span>{user?.teamName}</span><span className="workspace-role">{user?.role === "admin" ? "管理员" : "成员"}</span></div>
      <nav aria-label="主导航">{["工作台", "代码与规范", "管理"].map((group) => <div className="nav-group" key={group}><p>{group}</p>
        {navigation.filter((item) => item.group === group && (!item.access || (item.access === "team" ? user?.role === "admin" : user?.serviceRole === "service_admin"))).map((item) => <a key={item.key} href={item.href} aria-current={active === item.key ? "page" : undefined}><Icon name={item.icon} /><span>{item.label}</span>{active === item.key && <span className="nav-active-dot" />}</a>)}
      </div>)}</nav>
      <div className="sidebar-footer"><span className="readonly-symbol"><Icon name="git" size={16} /></span><div><strong>代码平台只读</strong><span>评审与讨论留在工作台</span></div></div>
    </aside>
    <header className="app-header"><div className="header-content">
      <button ref={menuButton} type="button" className="icon-button mobile-menu" aria-label="打开导航" aria-controls="workspace-navigation" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="menu" /></button>
      <div className="header-breadcrumb"><span>工作空间</span><Icon name="chevron-right" size={14} /><strong>{currentPage}</strong></div>
      <div className="header-actions"><UnreadIndicator /><button type="button" className="button secondary-button header-start" onClick={() => setStartOpen(true)}><Icon name="plus" size={15} />发起评审</button><AccountControls /></div>
    </div></header>
    {startOpen && <StartReviewDialog onClose={() => setStartOpen(false)} />}
    <span id="workspace-content" className="content-anchor" tabIndex={-1} />
  </>;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : date.toLocaleString("zh-CN", { hour12: false });
}
