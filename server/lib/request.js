// ─── Request Log (in-memory ring buffer + DB persistence) ───────────────────
// Standalone module. Call init(db) once after DB is ready to enable persistence.

const REQUEST_LOG_MAX = 100;
const requestLog = [];
let requestLogSeq = 0;
let _db = null;

async function init(db) {
    _db = db;
    try {
        const result = await db.query(
            `SELECT id, timestamp, direction, label, detail, status
             FROM request_log ORDER BY timestamp DESC LIMIT $1`,
            [REQUEST_LOG_MAX]
        );
        // Insert oldest-first into ring buffer
        result.rows.reverse().forEach(row => {
            requestLog.push({
                id: ++requestLogSeq,
                timestamp: row.timestamp instanceof Date
                    ? row.timestamp.toISOString()
                    : row.timestamp,
                direction: row.direction,
                label: row.label,
                detail: row.detail,
                status: row.status
            });
        });
        if (requestLog.length > REQUEST_LOG_MAX) {
            requestLog.splice(0, requestLog.length - REQUEST_LOG_MAX);
        }
    } catch (_) {}
}

function logConnection({ direction, label, detail, status = 'ok' }) {
    const entry = {
        id: ++requestLogSeq,
        timestamp: new Date().toISOString(),
        direction,
        label,
        detail,
        status
    };
    requestLog.push(entry);
    if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift();

    if (_db) {
        _db.query(
            `INSERT INTO request_log (timestamp, direction, label, detail, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [entry.timestamp, entry.direction, entry.label, entry.detail, entry.status]
        ).catch(() => {});
    }
}

function getRequestLog() {
    return requestLog;
}

module.exports = { init, logConnection, getRequestLog };
