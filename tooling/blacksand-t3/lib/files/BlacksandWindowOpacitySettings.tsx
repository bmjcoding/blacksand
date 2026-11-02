import { useEffect, useState, useRef, type CSSProperties } from "react";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { applyWindowTint, loadWindowTint } from "../../blacksandWindowMaterial";
import { searchableSetting } from "./settingsSearch";

let writes = Promise.resolve();

/** Background tint lives with desktop window settings, independent of Glass. */
export function BlacksandWindowOpacitySettings() {
  const bridge = window.desktopBridge;
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changeRevision = useRef(0);
  useEffect(() => {
    let active = true;
    void loadWindowTint().then((value) => { if (active) setPercent(value); }).catch(() => {});
    return () => { active = false; };
  }, [bridge]);
  if (percent === null || !bridge?.setBlacksandWindowOpacity) return null;
  const change = (value: number) => {
    const revision = ++changeRevision.current;
    setPercent(value);
    setError(null);
    // Preserve slider event order even if IPC/disk writes finish at different times.
    writes = writes.then(async () => {
      try {
        await bridge.setBlacksandWindowOpacity!(value);
        applyWindowTint(value);
        if (revision === changeRevision.current) { setPercent(value); setError(null); }
      } catch {
        const saved = await loadWindowTint();
        if (revision === changeRevision.current) {
          setPercent(saved);
          setError("Window background tint could not be saved.");
        }
      }
    });
  };
  const ratio = (percent - 50) / 50;
  return <SettingsRow
    {...searchableSetting("blacksand-window-opacity")}
    description={error ?? "Tint over native macOS background blur. Text, controls and popups keep their appearance."}
    resetAction={percent === 100 ? null : <SettingResetButton label="window background tint" onClick={() => change(100)} />}
    control={<div className="flex w-full items-center gap-3 sm:w-52">
      <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground" htmlFor="blacksand-window-opacity">{percent}%</output>
      <input aria-label="Window background tint" id="blacksand-window-opacity" type="range" min={50} max={100} step={1} value={percent}
        className="settings-slider min-w-0 flex-1"
        style={{ "--settings-slider-progress": `${ratio * 100}%`, "--settings-slider-fill-offset": `${0.5 - ratio}rem` } as CSSProperties}
        onChange={(event) => change(Number(event.currentTarget.value))} />
    </div>} />;
}
