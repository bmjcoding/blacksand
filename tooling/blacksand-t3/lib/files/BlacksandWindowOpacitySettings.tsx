import { useEffect, useState, type CSSProperties } from "react";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Native preference lives with desktop window settings, independent of Glass. */
export function BlacksandWindowOpacitySettings() {
  const bridge = window.desktopBridge;
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void bridge?.getBlacksandWindowOpacity?.().then((value) => { if (active) setPercent(value); }).catch(() => {});
    return () => { active = false; };
  }, [bridge]);
  if (percent === null || !bridge?.setBlacksandWindowOpacity) return null;
  const change = (value: number) => {
    setPercent(value);
    setError(null);
    void bridge.setBlacksandWindowOpacity!(value).catch(() => setError("Window opacity could not be saved."));
  };
  const ratio = (percent - 50) / 50;
  return <SettingsRow
    {...searchableSetting("blacksand-window-opacity")}
    description={error ?? "Adjust the entire desktop window, including text and controls."}
    resetAction={percent === 100 ? null : <SettingResetButton label="window opacity" onClick={() => change(100)} />}
    control={<div className="flex w-full items-center gap-3 sm:w-52">
      <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground" htmlFor="blacksand-window-opacity">{percent}%</output>
      <input aria-label="Window opacity" id="blacksand-window-opacity" type="range" min={50} max={100} step={1} value={percent}
        className="settings-slider min-w-0 flex-1"
        style={{ "--settings-slider-progress": `${ratio * 100}%`, "--settings-slider-fill-offset": `${0.5 - ratio}rem` } as CSSProperties}
        onChange={(event) => change(Number(event.currentTarget.value))} />
    </div>} />;
}
