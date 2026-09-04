// ui/src/actions/Modal.tsx — the tiny modal shell the three annotate forms
// share. No new dependency: a fixed overlay + a bordered token panel, Escape
// to close, focus trapped only as far as autofocusing the first field (the
// MVP is a keyboard-driven tool, not a component library).
import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  title, subtitle, onClose, children, wide = false,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Settings/cheat-sheet need a wider panel than the annotate forms. */
  readonly wide?: boolean;
}): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The Settings key-binding recorder marks its button while it is
      // listening; Escape there means "cancel recording", not "close the
      // dialog", and this window-CAPTURE listener would otherwise always
      // win the race against the button's own handler.
      if (e.key === "Escape" && document.querySelector('[data-hbc-recording="true"]') === null) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    panel.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 pt-24" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-label={title}
        data-hbc-keys="off"
        className={`${wide ? "w-[min(51.25rem,94vw)]" : "w-[min(32.5rem,92vw)]"} rounded-ui border border-border bg-surface text-text`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-3 py-2 text-xs">
          <div className="text-text">{title}</div>
          {subtitle !== undefined && <div className="pt-0.5 text-text-muted">{subtitle}</div>}
        </div>
        <div className="p-3 text-xs">{children}</div>
      </div>
    </div>
  );
}

export const fieldClass =
  "h-7 w-full rounded-ui border border-border bg-surface-2 px-2 text-xs text-text outline-none focus:border-accent";
export const areaClass =
  "hbc-scroll h-24 w-full rounded-ui border border-border bg-surface-2 p-2 text-xs text-text outline-none focus:border-accent";
export const labelClass = "block pb-1 text-text-muted";

export function ErrorNote({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="mt-2 rounded-ui border border-sev-crit px-2 py-1 font-mono text-xs text-sev-crit">{children}</div>
  );
}
