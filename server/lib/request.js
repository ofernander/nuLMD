// ─── Request Log (in-memory ring buffer) ─────────────────────────────────────
// Standalone module with no app-level dependencies — safe to require from
// anywhere without circular dependency risk.

const REQUEST_LOG_MAX = 100;
const requestLog = [];
let requestLogSeq = 0;

function logConnection({ direction, label, detail, status = 'ok' }) {
    requestLog.push({
        id: ++requestLogSeq,
        timestamp: new Date().toISOString(),
        direction, // 'inbound' | 'outbound'
        label,
        detail,
        status     // 'ok' | 'cached' | 'error'
    });
    if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift();
}

function getRequestLog() {
    return requestLog;
}

module.exports = { logConnection, getRequestLog };
