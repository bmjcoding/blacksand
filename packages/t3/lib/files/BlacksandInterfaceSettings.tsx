// Injected by blacksand into Settings -> Appearance -> Interface: one switch
// per Blacksand touch (blacksandInterface.ts). Each row carries its Settings
// search id, which settingsSearch.ts registers, so searching finds it.

import {
  BLACKSAND_INTERFACE,
  BLACKSAND_INTERFACE_KEYS,
  blacksandInterfaceSearchId,
  setBlacksandInterface,
  useBlacksandInterface,
  type BlacksandInterfaceKey,
} from "../../blacksandInterface";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function BlacksandInterfaceRow({ setting }: { setting: BlacksandInterfaceKey }) {
  const on = useBlacksandInterface(setting);
  const { title, description } = BLACKSAND_INTERFACE[setting];
  return (
    <SettingsRow
      {...searchableSetting(blacksandInterfaceSearchId(setting))}
      description={description}
      resetAction={
        on ? null : <SettingResetButton label={title} onClick={() => setBlacksandInterface(setting, true)} />
      }
      control={
        <Switch checked={on} onCheckedChange={(checked) => setBlacksandInterface(setting, Boolean(checked))} aria-label={title} />
      }
    />
  );
}

export function BlacksandInterfaceSettings() {
  return (
    <>
      {BLACKSAND_INTERFACE_KEYS.map((setting) => (
        <BlacksandInterfaceRow key={setting} setting={setting} />
      ))}
    </>
  );
}
