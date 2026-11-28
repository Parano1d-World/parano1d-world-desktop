// Fixed addresses on the user's own computer, defined once and used by the app.
// The mining dashboard listens only on this computer (loopback): nothing on the internet or the local network can
// reach it, and it also needs the access code from that computer's user account. Phones never use it.
'use strict';
const DASHBOARD_HOST = '127.0.0.1', DASHBOARD_PORT = 17861;
module.exports = {
  DASHBOARD_HOST, DASHBOARD_PORT,
  DASHBOARD: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`,
  /** The official Parano1d node's standard ports: peer-to-peer and its local control port. */
  NODE_P2P_PORT: 9600, NODE_RPC_PORT: 9601,
};
