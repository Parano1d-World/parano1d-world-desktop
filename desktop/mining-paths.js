// Where mining from the Desktop Wallet lives on Mac and Linux. Everything is in one folder of its own, for this
// user only; ~/.parano1d (a node the person may already run) is never used.
'use strict';
const path = require('path');

exports.SERVICE_LABEL = 'com.parano1dworld.mining';
exports.SERVICE_UNIT = 'parano1d-world-mining.service';

exports.miningPaths = function miningPaths(home, platform, env = {}) {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Parano1dWorld', 'mining')
    : path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), 'parano1d-world', 'mining');
  return {
    base,
    core: path.join(base, 'core'),          // the official Parano1d node program, by version
    chain: path.join(base, 'chain'),        // the node's config and blockchain copy (optional to keep on remove)
    rigData: path.join(base, 'rig-data'),   // dashboard settings, wallets list, paired devices, access code
    profile: path.join(base, 'service-profile'),
    serviceFile: path.join(base, 'service.json'),   // what the app installed (read by Remove and Update Miner)
    runningFile: path.join(base, 'service-running.json'),
    plist: path.join(home, 'Library', 'LaunchAgents', exports.SERVICE_LABEL + '.plist'),
    unit: path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), 'systemd', 'user', exports.SERVICE_UNIT),
  };
};
