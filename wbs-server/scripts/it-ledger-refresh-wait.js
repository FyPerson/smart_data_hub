'use strict';
// Waits for the ledger page's own post-write refresh (the page has no refresh button to poll any more).
// A page refresh round always starts with GET /api/it-assets/me and ends with GET /api/it-assets/floors. A round
// counts for a write only if its /me was *requested after* that write, and only once the /floors of that same round
// has answered successfully; then #itlContent must no longer be aria-busy. A stray /floors read by a view (no /me
// after the write) or a round that was already in flight before the write never satisfies the wait, so a write path
// that forgets its refresh times out and fails. The helper never triggers a refresh itself.
function trackWriteRefresh(page, { timeout = 15000 } = {}) {
  let writes = 0, roundStart = -1, refreshedFor = -1;
  const floorsRound = new WeakMap(), waiters = new Set();
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith('/api/it-assets')) return;
    if (request.method() !== 'GET') { writes++; return; }
    if (pathname === '/api/it-assets/me') roundStart = writes;
    else if (pathname === '/api/it-assets/floors' && roundStart >= 0) floorsRound.set(request, roundStart);
  });
  page.on('response', response => {
    const request = response.request();
    if (!floorsRound.has(request) || !response.ok()) return;
    refreshedFor = Math.max(refreshedFor, floorsRound.get(request));
    for (const wake of [...waiters]) wake();
  });
  return async function settled() {
    const target = writes;
    if (refreshedFor < target) {
      await new Promise((resolve, reject) => {
        const wake = () => { if (refreshedFor >= target) { clearTimeout(timer); waiters.delete(wake); resolve(); } };
        const timer = setTimeout(() => { waiters.delete(wake); reject(new Error('写操作后页面没有完成一轮刷新（等待 ' + timeout + 'ms）')); }, timeout);
        waiters.add(wake);
      });
    }
    await page.waitForFunction(() => !document.querySelector('#itlContent').hasAttribute('aria-busy'));
  };
}
module.exports = { trackWriteRefresh };
