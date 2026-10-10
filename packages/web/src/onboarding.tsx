import { useEffect, useState } from "react";
import { ApiError } from "./api";
import { useSession } from "./auth";
import { Icon } from "./icons";
import { getOnboarding, type OnboardingChecklist } from "./instance-api";
import { StartReviewDialog } from "./start-review";
import "./onboarding.css";

const stepLabels = {
  models: { title: "配置模型", detail: "为 Generator 和 Grader 配置模型连接。", action: "配置模型" },
  repository: { title: "接入仓库", detail: "接入团队的第一个 GitLab 仓库。", action: "接入仓库" },
  webhook: { title: "配置 webhook", detail: "配置 webhook，并收到第一个通过鉴权的事件。", action: "配置与检测" },
  rules: { title: "启用规范", detail: "启用至少一条团队或仓库规范。", action: "选择规范" },
  review: { title: "得到第一份评审", detail: "发起评审，等待第一轮评审完成。", action: "发起评审" },
};

export function Onboarding({ refreshKey }: { refreshKey: number }) {
  const { user } = useSession();
  const [data, setData] = useState<OnboardingChecklist>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  const storageKey = `ureview:onboarding:${user?.userId}:${user?.teamId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "collapsed"; } catch { return false; }
  });
  useEffect(() => {
    if (user?.role !== "admin") return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void getOnboarding(controller.signal).then((result) => { if (!controller.signal.aborted) { setData(result); setDenied(false); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) {
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { setData(undefined); setDenied(true); }
        else setError(cause instanceof Error ? cause.message : "引导清单暂时无法读取，请重试。");
      } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user?.role, user?.teamId, refreshKey, attempt]);
  if (user?.role !== "admin" || denied || data?.completed) return null;
  const completedCount = data?.steps.filter((step) => step.completed).length ?? 0;
  function toggle() {
    setCollapsed((current) => {
      try { localStorage.setItem(storageKey, current ? "expanded" : "collapsed"); } catch { /* 浏览器未提供存储时，收起状态保留到本次页面结束。 */ }
      return !current;
    });
  }
  return <section className="dashboard-surface onboarding-checklist" aria-labelledby="onboarding-title">
    <div className="onboarding-heading"><div><h2 id="onboarding-title">首次使用引导</h2><p>{data ? `已完成 ${completedCount} / 5 步` : "按系统记录显示配置进度。"}</p></div>
      <button type="button" className="text-button" aria-expanded={!collapsed} aria-controls="onboarding-steps" onClick={toggle}>{collapsed ? "展开引导" : "收起引导"}</button></div>
    {!collapsed && <>
      {loading && !data && <p role="status" className="onboarding-loading">正在读取引导清单…</p>}
      {error && <div role="alert" className="feedback feedback-error"><p>{error}</p><button type="button" className="button secondary-button" disabled={loading} onClick={() => setAttempt((current) => current + 1)}>重新加载引导</button></div>}
      {data && <ol id="onboarding-steps" className="onboarding-steps" aria-busy={loading}>{data.steps.map((step, index) => {
        const label = stepLabels[step.id];
        const href = step.id === "models" ? "/?instance=1#model-settings" : step.id === "repository" ? "/?repositories=1&tab=connect"
          : step.id === "webhook" ? data.repositoryId ? `/?repository=${encodeURIComponent(data.repositoryId)}&tab=events` : "/?repositories=1&tab=connect" : "/?rules=1&tab=library";
        return <li key={step.id} className={`onboarding-step${step.completed ? " is-complete" : ""}`}>
          <span className="onboarding-step-marker" aria-hidden="true">{step.completed ? <Icon name="check" size={15} /> : index + 1}</span>
          <div className="onboarding-step-content"><div className="onboarding-step-title"><strong>{label.title}</strong><span className="onboarding-step-status">{step.completed ? "已完成" : "待完成"}</span></div><p>{label.detail}</p></div>
          {step.id === "models" && !data.canManageModels ? <span className="onboarding-contact">请联系服务管理员</span>
            : step.id === "review" ? <button className="text-button onboarding-step-action" type="button" onClick={() => setStartOpen(true)}>{label.action}<Icon name="arrow-right" size={13} /></button>
              : <a className="onboarding-step-action" href={href}>{label.action}<Icon name="arrow-right" size={13} /></a>}
        </li>;
      })}</ol>}
    </>}
    {startOpen && <StartReviewDialog onClose={() => { setStartOpen(false); setAttempt((current) => current + 1); }} />}
  </section>;
}
