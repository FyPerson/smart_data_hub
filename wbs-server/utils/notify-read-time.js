'use strict';

// DingTalk timestamps arrive at callers already normalized to milliseconds.
function formatNotifyReadTime(ms) {
    if (!Number.isFinite(ms)) throw new TypeError('read timestamp must be finite milliseconds');
    return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
}

module.exports = { formatNotifyReadTime };
