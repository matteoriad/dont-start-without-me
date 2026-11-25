// Entry point. Starts the relay unconditionally: some hosts (e.g. Hostinger's
// managed Node.js, which runs apps through LiteSpeed/Passenger) load this file
// via require(), so a "require.main === module" check would never start it.
const { createRelay } = require("./lib/relay");

// PORT can be a number or, behind Passenger, a socket path — pass it through as-is.
const port = process.env.PORT || 8787;
const disableWebSocket = process.env.RELAY_DISABLE_WS === "1";

createRelay({ port, disableWebSocket })
  .listen()
  .then((addr) => console.log(`relay listening on ${addr}${disableWebSocket ? " (HTTP only)" : ""}`));
