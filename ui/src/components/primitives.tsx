// ui/src/components/primitives.tsx — the shadcn-style local primitives the
// shell composes (spec 20 §1.3: "compose, don't style"). Radix behaviour +
// token classes only; no raw colours, no shadows (flat and bordered).
import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function ToolButton({
  children, active = false, tip, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly active?: boolean; readonly tip?: string }): ReactNode {
  const btn = (
    <button
      type="button"
      className={clsx(
        "inline-flex h-7 items-center gap-1 rounded-ui border px-2 text-xs",
        "border-border transition-colors outline-none",
        "focus-visible:border-accent",
        active ? "bg-accent text-accent-fg" : "bg-surface-2 text-text hover:border-accent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  if (tip === undefined) return btn;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{btn}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={4}
          className="rounded-ui border border-border bg-surface-2 px-2 py-1 text-xs text-text"
        >
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function PaneHeader({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-xs text-text-muted">
      {children}
    </div>
  );
}

export function Row({
  children, selected = false, onSelect,
}: { readonly children: ReactNode; readonly selected?: boolean; readonly onSelect?: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        "flex w-full items-center gap-2 px-2 text-left text-xs",
        "h-[var(--row-height)] border-l-2",
        selected ? "border-l-accent bg-surface-2 text-text" : "border-l-transparent text-text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="p-3 text-xs text-text-muted">{children}</div>;
}

export function Stub({ what }: { readonly what: string }): ReactNode {
  return (
    <div className="m-2 rounded-ui border border-dashed border-border p-3 text-xs text-text-muted">
      <span className="text-text">stub</span> — {what}
    </div>
  );
}
