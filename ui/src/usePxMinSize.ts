// ui/src/usePxMinSize.ts — react-resizable-panels sizes panels in percent,
// but the shell's requirement is in PIXELS (left >= 220px, right >= 280px:
// the panes must not become unusably narrow). Measure the group and convert.
import { useCallback, useEffect, useRef, useState } from "react";

export function usePxMinSize(): {
  readonly ref: (el: HTMLDivElement | null) => void;
  readonly pct: (px: number) => number;
} {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (el === null) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  // Before the first measurement, fall back to a sane percentage so the
  // first paint is never a zero-width pane.
  const pct = useCallback((px: number) => (width > 0 ? Math.min(90, (px / width) * 100) : 15), [width]);
  return { ref, pct };
}
