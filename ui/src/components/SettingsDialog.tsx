// ui/src/components/SettingsDialog.tsx — the in-app config the owner asked
// for (docs/UI.md, "Settings dialog"): theme preset, density, keymap preset,
// a full key-binding editor, and a read-only view of the resolved token
// overrides. It changes NOTHING about the layout — art direction stays
// Fred's — and every dial it offers is one the shell already had, just with
// no way to reach it from inside the app.
//
// Persistence is the theme's: localStorage, wrapped, per dial. Key bindings
// layer on `ui/keymap.json`'s `overrides` through the ONE shared resolver
// (`@ui-core/keymap-resolve.ts`), never a second resolution path.
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formatChord } from "@ui-core/keymap.ts";
import { chordConflicts, mergeBindings, rebind, resetAction, unbindAction } from "@ui-core/keymap-resolve.ts";
import { Modal } from "../actions/Modal.tsx";
import { isMacPlatform, toKeyEvent } from "../actions/keys.ts";
import {
  activeBindings, getKeymapConfig, registry, resetKeymapConfig, setKeymapConfig, useKeymapConfig,
} from "../actions/registry.ts";
import { PRESETS } from "../keymap-config.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { chordLabel } from "./KeymapHelp.tsx";
import themeConfig from "../../theme.json";

const rowBtn = "h-6 rounded-ui border border-border px-2 text-xs text-text-muted hover:text-text";
const activeBtn = "h-6 rounded-ui border border-accent px-2 text-xs text-accent";

function Choice<T extends string>({
  label, options, value, onChange, testid,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly onChange: (v: T) => void;
  readonly testid: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-32 shrink-0 text-text-muted">{label}</span>
      <div className="flex gap-1" data-testid={testid}>
        {options.map((o) => (
          <button key={o} type="button" data-value={o} aria-pressed={o === value} className={o === value ? activeBtn : rowBtn} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Pending {
  actionId: string;
  chord: string;
  conflicts: { chord: string; actionId: string }[];
}

function Bindings(): ReactNode {
  const config = useKeymapConfig();
  const mac = isMacPlatform();
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preset = PRESETS[config.preset] ?? {};
  const overrides = config.overrides ?? {};
  const bindings = activeBindings();
  const chordOf = (id: string): string | undefined => Object.entries(bindings).find(([, a]) => a === id)?.[0];

  const apply = (next: Record<string, string | null>): void => {
    try {
      setKeymapConfig({ preset: getKeymapConfig().preset, overrides: next });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const commit = (actionId: string, chord: string, mode: "replace" | "swap"): void => {
    apply(rebind(preset, overrides, actionId, chord, mode));
    setPending(null);
  };

  const onRecordKey = (actionId: string, e: ReactKeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      setPending(null);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      setRecording(null);
      setPending(null);
      apply(unbindAction(preset, overrides, actionId));
      return;
    }
    const chord = formatChord(toKeyEvent(e.nativeEvent, mac));
    if (chord === undefined) return; // a modifier on its own — keep listening
    setRecording(null);
    let conflicts: { chord: string; actionId: string }[];
    try {
      conflicts = chordConflicts(mergeBindings(preset, overrides), chord, actionId).map((c) => ({ chord: c.chord, actionId: c.actionId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (conflicts.length === 0) commit(actionId, chord, "replace");
    else setPending({ actionId, chord, conflicts });
  };

  const title = (id: string): string => registry.get(id)?.title ?? id;

  return (
    <div>
      <div className="flex items-center justify-between pb-1">
        <span className="text-text-muted">
          Click Record, then press the chord. Escape cancels, Backspace unbinds.
        </span>
        <button type="button" className={rowBtn} data-testid="reset-all-bindings" onClick={() => { resetKeymapConfig(); setError(null); }}>
          reset all to preset
        </button>
      </div>
      {error !== null && <div className="mb-1 rounded-ui border border-sev-crit px-2 py-1 font-mono text-sev-crit">{error}</div>}
      <div className="hbc-scroll max-h-[38vh] overflow-auto rounded-ui border border-border">
        {registry.list().map((a) => {
          const chord = chordOf(a.id);
          const isPending = pending?.actionId === a.id;
          return (
            <div key={a.id} data-binding-row={a.id} className="flex items-center gap-2 border-b border-border px-2 py-1 last:border-b-0">
              <span className="w-56 shrink-0 truncate text-text">{a.title}</span>
              <span className="w-40 shrink-0 truncate font-mono text-text-muted" data-binding-chord>
                {recording === a.id ? "press a chord…" : chord === undefined ? "—" : chordLabel(chord, mac)}
              </span>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                data-record={a.id}
                data-hbc-recording={recording === a.id ? "true" : undefined}
                className={recording === a.id ? activeBtn : rowBtn}
                onClick={() => { setRecording(a.id); setPending(null); }}
                onKeyDown={(e) => (recording === a.id ? onRecordKey(a.id, e) : undefined)}
                onBlur={() => (recording === a.id ? setRecording(null) : undefined)}
                ref={(el) => { if (recording === a.id) el?.focus(); }}
              >
                {recording === a.id ? "recording" : "Record"}
              </button>
              <button type="button" data-reset={a.id} className={rowBtn} onClick={() => apply(resetAction(preset, overrides, a.id))}>
                reset
              </button>
              {isPending && pending !== null && (
                <div data-testid="binding-conflict" className="w-full basis-full pt-1 text-sev-high">
                  <span className="font-mono">{chordLabel(pending.chord, mac)}</span> is already bound to{" "}
                  {pending.conflicts.map((c) => title(c.actionId)).join(", ")}.
                  <button type="button" data-testid="conflict-swap" className={`${rowBtn} ml-2`} onClick={() => commit(a.id, pending.chord, "swap")}>
                    swap
                  </button>
                  <button type="button" data-testid="conflict-replace" className={`${rowBtn} ml-1`} onClick={() => commit(a.id, pending.chord, "replace")}>
                    replace
                  </button>
                  <button type="button" data-testid="conflict-cancel" className={`${rowBtn} ml-1`} onClick={() => setPending(null)}>
                    cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Bur 12 (docs/UI-BURS.md #12): the ONLY place the full preset list
 *  appears — but split into the two mode-filtered slot selects, never one
 *  menu of everything. Picking a preset here fills that slot; it does not
 *  change which slot (`light`/`dark`) is currently active — only the
 *  toolbar button / `view.themeToggle` do that. */
function SlotSelect({
  label, testid, options, value, onChange,
}: {
  readonly label: string;
  readonly testid: string;
  readonly options: readonly string[];
  readonly value: string;
  readonly onChange: (v: string) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-32 shrink-0 text-text-muted">{label}</span>
      <select
        data-testid={testid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 rounded-ui border border-border bg-surface-2 px-1 text-xs text-text outline-none focus-visible:border-accent"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function TokenOverrides(): ReactNode {
  const cfg = themeConfig as { preset?: string; overrides?: Record<string, unknown> };
  const rows = Object.entries(cfg.overrides ?? {});
  return (
    <div className="rounded-ui border border-border px-2 py-1 font-mono text-text-muted" data-testid="token-overrides">
      <div>ui/theme.json preset: {cfg.preset ?? "dark"}</div>
      {rows.length === 0 ? (
        <div>no token overrides — the preset is used as shipped</div>
      ) : (
        rows.map(([k, v]) => (
          <div key={k}>
            {k} = {String(v)}
          </div>
        ))
      )}
    </div>
  );
}

export function SettingsDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const { light, dark, lightPresets, darkPresets, density, setLight, setDark, setDensity } = useTheme();
  const keymapCfg = useKeymapConfig();
  const [tab, setTab] = useState<"appearance" | "keys">("appearance");

  return (
    <Modal title="Settings" subtitle="theme, density and key bindings — saved in this browser" onClose={onClose} wide>
      <div className="flex gap-1 pb-2" data-testid="settings-tabs">
        {(["appearance", "keys"] as const).map((t) => (
          <button key={t} type="button" data-tab={t} className={t === tab ? activeBtn : rowBtn} onClick={() => setTab(t)}>
            {t === "keys" ? "key bindings" : t}
          </button>
        ))}
      </div>
      {tab === "appearance" ? (
        <div>
          <SlotSelect label="Light theme" testid="theme-light-select" options={lightPresets} value={light} onChange={setLight} />
          <SlotSelect label="Dark theme" testid="theme-dark-select" options={darkPresets} value={dark} onChange={setDark} />
          <Choice label="density" testid="theme-density" options={["comfortable", "compact"] as const} value={density} onChange={setDensity} />
          <Choice
            label="keymap preset"
            testid="keymap-preset"
            options={Object.keys(PRESETS)}
            value={keymapCfg.preset}
            onChange={(p) => setKeymapConfig({ preset: p, overrides: keymapCfg.overrides ?? {} })}
          />
          <div className="pt-2 pb-1 text-text-muted">resolved token overrides (read-only — edit ui/theme.json)</div>
          <TokenOverrides />
        </div>
      ) : (
        <Bindings />
      )}
      <div className="flex justify-end pt-2">
        <button type="button" className="h-7 rounded-ui border border-accent px-2 text-accent" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
