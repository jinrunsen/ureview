import { useRef, useState } from "react";
import { deleteManagedRule, type ManagedRule } from "./managed-rules-api";
import { DetailDrawer } from "./ui";

export function ManagedRuleDeletion({ rule, disabled, onDeleted }: {
  rule: Pick<ManagedRule, "id" | "version" | "name">; disabled?: boolean; onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestPending = useRef(false);
  function close() { if (!requestPending.current) setConfirming(false); }
  async function remove() {
    if (requestPending.current) return;
    requestPending.current = true; setBusy(true); setError("");
    try { await deleteManagedRule(rule.id, rule.version); onDeleted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除规范失败，请重试。"); }
    finally { requestPending.current = false; setBusy(false); }
  }
  return <><button type="button" className="button secondary-button rule-delete-trigger" disabled={disabled || busy} onClick={() => { setError(""); setConfirming(true); }}>删除规范</button>
    {confirming && <DetailDrawer title="删除规范" onClose={close}>
      <div className="rule-deletion-confirmation">
        <p>确认删除规范「<strong>{rule.name}</strong>」？</p>
        <p>删除后，此规范不再参与后续评审。历史评审及当时的规范快照会保留。</p>
        <p>删除后无法恢复。</p>
        {error && <p role="alert" className="feedback feedback-error">{error}</p>}
        <div className="managed-editor-actions"><button type="button" className="button secondary-button" disabled={busy} onClick={close}>取消</button><button type="button" className="button rule-delete-button" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "确认删除"}</button></div>
      </div>
    </DetailDrawer>}
  </>;
}
