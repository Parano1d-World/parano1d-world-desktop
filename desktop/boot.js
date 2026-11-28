// Entry point. Normally the wallet window (main.js). Started by the computer's own service manager with
// --p1w-mining-service (Mac LaunchAgent / Linux systemd user service, set up from Mining → This computer), it runs
// only the local mining dashboard (local-ports.js) with no window, so mining keeps going after the wallet is closed.
'use strict';
if (process.argv.includes('--p1w-mining-service')) require('./mining-service.js').run();
else require('./main.js');
