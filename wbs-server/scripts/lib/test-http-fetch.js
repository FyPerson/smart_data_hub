'use strict';

// Ephemeral HTTP fixtures can reuse an origin immediately after server.close().
// A process-global fetch pool may still hold that old server's idle socket.
// Do not pool these test requests across fixture lifetimes. No retries: transport
// failures (including failed writes) must still reject on their first attempt.
module.exports = function fetchTestHttp(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Connection', 'close');
  return fetch(url, { ...options, headers });
};
