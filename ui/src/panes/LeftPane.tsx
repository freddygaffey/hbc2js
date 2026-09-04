// ui/src/panes/LeftPane.tsx — Modules / Leads tabs. Placeholder trees with
// fake rows (landing 2 replaces them with the real module tree + function
// list); the right-click menu is the primary workflow surface (spec 22
// §3.3), so its shape is already here as a stub.
import * as Tabs from "@radix-ui/react-tabs";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useState, type ReactNode } from "react";
import { PaneHeader, Row } from "../components/primitives.tsx";
import { useLeads } from "../hooks.ts";

const FAKE_MODULES: readonly { readonly id: number; readonly file: string; readonly fns: readonly string[] }[] = [
  { id: 0, file: "index.js", fns: ["onAppStart", "renderRoot"] },
  { id: 1, file: "auth/licence.js", fns: ["validateLicence", "verifySignature"] },
  { id: 2, file: "net/config.js", fns: ["fetchRemoteConfig"] },
  { id: 3, file: "storage/keychain.js", fns: ["storeToken", "decryptPayload"] },
];

const MENU_ITEMS: readonly string[] = ["Rename", "Add comment", "Go to definition", "Find xrefs", "Mark reviewed", "Copy disasm offset"];

function RowMenu({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-44 rounded-ui border border-border bg-surface p-1 text-xs text-text">
          {MENU_ITEMS.map((label) => (
            <ContextMenu.Item
              key={label}
              disabled
              className="flex h-7 items-center rounded-ui px-2 outline-none data-[disabled]:text-text-muted data-[highlighted]:bg-surface-2"
            >
              {label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const tabClass =
  "h-7 flex-1 rounded-ui px-2 text-xs text-text-muted outline-none data-[state=active]:bg-surface-2 data-[state=active]:text-text";

export function LeftPane({ selected, onSelect }: { readonly selected: number; readonly onSelect: (fn: number) => void }): ReactNode {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set([1]));
  const leads = useLeads();
  const toggle = (id: number): void => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <Tabs.Root defaultValue="modules" className="flex h-full min-w-0 flex-col bg-surface">
      <PaneHeader>
        <Tabs.List className="flex w-full gap-1">
          <Tabs.Trigger value="modules" className={tabClass}>Modules</Tabs.Trigger>
          <Tabs.Trigger value="leads" className={tabClass}>Leads</Tabs.Trigger>
        </Tabs.List>
      </PaneHeader>
      <Tabs.Content value="modules" className="hbc-scroll min-h-0 flex-1 overflow-auto py-1 outline-none">
        {FAKE_MODULES.map((m) => (
          <div key={m.id}>
            <RowMenu>
              <div>
                <Row onSelect={() => toggle(m.id)}>
                  <span className="font-mono text-text-muted">{open.has(m.id) ? "v" : ">"}</span>
                  <span className="truncate">{m.file}</span>
                </Row>
              </div>
            </RowMenu>
            {open.has(m.id) &&
              m.fns.map((name, i) => {
                const fn = m.id * 10 + i;
                return (
                  <RowMenu key={name}>
                    <div>
                      <Row selected={fn === selected} onSelect={() => onSelect(fn)}>
                        <span className="pl-4 font-mono truncate">{name}</span>
                      </Row>
                    </div>
                  </RowMenu>
                );
              })}
          </div>
        ))}
      </Tabs.Content>
      <Tabs.Content value="leads" className="hbc-scroll min-h-0 flex-1 overflow-auto py-1 outline-none">
        {(leads.data?.groups ?? []).map((g) => (
          <div key={g.class}>
            <div className="px-2 py-1 text-xs text-text-muted uppercase">{g.class}</div>
            {g.leads.map((l) => (
              <RowMenu key={l.evidence}>
                <div>
                  <Row selected={l.fn === selected} onSelect={() => l.fn !== null && onSelect(l.fn)}>
                    <span className="font-mono truncate">{l.name ?? l.evidence}</span>
                    <span className="ml-auto text-text-muted">{l.detail}</span>
                  </Row>
                </div>
              </RowMenu>
            ))}
          </div>
        ))}
      </Tabs.Content>
    </Tabs.Root>
  );
}
