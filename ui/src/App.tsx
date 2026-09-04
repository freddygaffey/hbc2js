// ui/src/App.tsx — the Stage-3 shell (spec 22 §2): top bar, three resizable
// columns (left tree / centre listing / one right-hand panel at a time) and
// a collapsible activity pane. Comfortable density is the default: the
// shell must not feel cramped.
import * as Tooltip from "@radix-ui/react-tooltip";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useState, type ReactNode } from "react";
import { TopBar } from "./panes/TopBar.tsx";
import { LeftPane } from "./panes/LeftPane.tsx";
import { CenterPane } from "./panes/CenterPane.tsx";
import { RightPane } from "./panes/RightPane.tsx";
import { BottomPane } from "./panes/BottomPane.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { usePxMinSize } from "./usePxMinSize.ts";

/** Hard minimums, in CSS pixels (see usePxMinSize). */
export const MIN_LEFT_PX = 220;
export const MIN_RIGHT_PX = 280;
export const MIN_CENTER_PX = 360;

const handleClass =
  "w-px bg-border transition-colors data-[resize-handle-state=drag]:bg-accent data-[resize-handle-state=hover]:bg-accent";

export function App(): ReactNode {
  const [fn, setFn] = useState(10);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { ref, pct } = usePxMinSize();

  return (
    <Tooltip.Provider delayDuration={400}>
      <div className="flex h-screen flex-col bg-bg text-text">
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <div ref={ref} className="min-h-0 flex-1">
          <PanelGroup direction="horizontal" autoSaveId="hbc2js.shell">
            <Panel defaultSize={20} minSize={pct(MIN_LEFT_PX)} className="min-w-0 border-r border-border">
              <LeftPane selected={fn} onSelect={setFn} />
            </Panel>
            <PanelResizeHandle className={handleClass} />
            <Panel defaultSize={53} minSize={pct(MIN_CENTER_PX)} className="min-w-0">
              <CenterPane fn={fn} />
            </Panel>
            <PanelResizeHandle className={handleClass} />
            <Panel defaultSize={27} minSize={pct(MIN_RIGHT_PX)} className="min-w-0 border-l border-border">
              <RightPane fn={fn} />
            </Panel>
          </PanelGroup>
        </div>
        <BottomPane />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </Tooltip.Provider>
  );
}
