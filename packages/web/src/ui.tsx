import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

export function DetailDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      requestAnimationFrame(() => { if (!element?.open && opener.current?.isConnected) opener.current.focus({ preventScroll: true }); });
    };
  }, []);
  return <dialog ref={dialog} className="detail-drawer" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <header className="drawer-header"><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="关闭详情"><Icon name="close" /></button></header>
    <div className="drawer-body">{children}</div>
  </dialog>;
}
