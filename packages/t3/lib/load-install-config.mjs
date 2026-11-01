// Imported first by bin/t3, so util.mjs and the platform modules read
// the locations the install saved (lib/install-config.mjs). The build account
// has no saved config of its own: it's handed explicit paths.
//
// A saved config that can't be read or is invalid isn't thrown here, where it
// would stop even `configure` from repairing it: the CLI refuses every other
// command while `installConfigError` is set (bin/t3). So does a
// location the environment gives that can't be used (relative, or a
// BLACKSAND_T3_HOME in the clone); an empty one is unset.

import { INSTALL_CONFIG, applyInstallConfig, readInstallConfig, useLocations } from "./install-config.mjs";

let config = null;
let error = null;
let overridden = [];
if (process.env.BLACKSAND_T3_ROLE !== "builder") {
  try {
    config = readInstallConfig();
  } catch (caught) {
    error = caught;
  }
  overridden = applyInstallConfig(config);
  try {
    useLocations(process.env);
  } catch (caught) {
    error ??= caught;
  }
}

export const installConfig = config;
export const installConfigError = error;
export const overriddenByConfig = overridden;
export { INSTALL_CONFIG };
