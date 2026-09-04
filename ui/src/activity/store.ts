// ui/src/activity/store.ts — the bottom pane's own UI state (collapsed?,
// which tab), persisted to localStorage so a reload keeps the pane the way
// it was left. Every localStorage call is wrapped: a private-browsing tab
// (or any other reason `Storage` throws) degrades to in-memory only, never
// to a crash.
export type ActivityTab = "activity" | "log";

const COLLAPSED_KEY = "hbc2js.activity.collapsed";
const TAB_KEY = "hbc2js.activity.tab";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore — best-effort persistence only.
  }
}

function readTab(fallback: ActivityTab): ActivityTab {
  try {
    const v = window.localStorage.getItem(TAB_KEY);
    return v === "activity" || v === "log" ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeTab(value: ActivityTab): void {
  try {
    window.localStorage.setItem(TAB_KEY, value);
  } catch {
    // ignore — best-effort persistence only.
  }
}

/** Collapsed by default (spec 22's layout diagram: "activity: collapsed to
 *  a status line by default"). */
export const loadCollapsed = (): boolean => readBool(COLLAPSED_KEY, true);
export const saveCollapsed = (v: boolean): void => writeBool(COLLAPSED_KEY, v);

export const loadActiveTab = (): ActivityTab => readTab("activity");
export const saveActiveTab = (v: ActivityTab): void => writeTab(v);
