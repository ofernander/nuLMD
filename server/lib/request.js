// ─── Request Log (in-memory ring buffers + DB persistence) ──────────────────
// Standalone module. Call init(db) once after DB is ready to enable persistence.
//
// Two histories, one per direction, so a burst of one kind can never push the other out of view:
//   inbound  - someone asked nuLMD for something (Lidarr, a MusicBrainz client): the dashboard's Requests
//   outbound - nuLMD asked MusicBrainz, Wikipedia, Deezer... and got an answer back: the dashboard's Responses

// Each inbound row also carries the outgoing calls made while the request waited (`calls`, up to MAX_CALLS, `callsMore`
// more not kept), and the reply (`outcome`, `reply`, `durationMs`). The calls are found by an async context that trackRequest opens
// for each request, so nothing between the request and the call has to pass anything along.
//
// An image fetch is not one request: Lidarr pulls dozens of covers in a burst. They are grouped into one inbound row per
// client while they keep arriving (BURST_IDLE_MS), with the files as its `calls`.

const { AsyncLocalStorage } = require('node:async_hooks');

const REQUEST_LOG_MAX = 100;       // per direction
const MAX_CALLS = 25;              // outgoing calls kept per request
const BURST_IDLE_MS = 10 * 1000;   // an image burst ends after this much quiet...
const BURST_MAX_MS = 2 * 60 * 1000; // ...or this long altogether
const BURST_MAX_FILES = 100;       // files listed per burst (the totals stay exact)
const DIRECTIONS = ['inbound', 'outbound'];
const logs = { inbound: [], outbound: [] };
let requestLogSeq = 0;
let _db = null;
const requestContext = new AsyncLocalStorage();
const bursts = new Map();          // client -> the image burst still open

const PRUNE_BATCH = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete request-log rows older than `days` days, in batches so a big backlog never holds the table for long.
 * Returns how many rows were deleted. (The dashboard only ever shows the latest 100 per direction.)
 */
async function pruneRequestLog(db, days) {
    if (!(days > 0)) return 0;
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    let deleted = 0;
    for (;;) {
        const result = await db.query(
            `DELETE FROM request_log WHERE id IN (SELECT id FROM request_log WHERE timestamp < $1 LIMIT ${PRUNE_BATCH})`, [cutoff]);
        const n = result && result.rowCount ? result.rowCount : 0;
        deleted += n;
        if (n < PRUNE_BATCH) return deleted;
    }
}

/**
 * @param db  anything with query()
 * @param options.retentionDays  when set (> 0) old rows are deleted a minute after start and then once a day
 */
async function init(db, { retentionDays = 0 } = {}) {
    _db = db;
    if (retentionDays > 0) {
        const run = () => pruneRequestLog(db, retentionDays).catch(() => {});
        const first = setTimeout(run, 60 * 1000);
        const daily = setInterval(run, DAY_MS);
        if (first.unref) first.unref();
        if (daily.unref) daily.unref();
    }
    for (const direction of DIRECTIONS) {
        try {
            const result = await db.query(
                `SELECT id, timestamp, direction, label, detail, status, api, client_ip, client_name, outcome, duration_ms, calls, reply
                 FROM request_log WHERE direction = $1 ORDER BY timestamp DESC LIMIT $2`,
                [direction, REQUEST_LOG_MAX]
            );
            // Insert oldest-first into the ring buffer
            result.rows.reverse().forEach(row => {
                logs[direction].push({
                    id: ++requestLogSeq,
                    timestamp: row.timestamp instanceof Date
                        ? row.timestamp.toISOString()
                        : row.timestamp,
                    direction: row.direction,
                    label: row.label,
                    detail: row.detail,
                    status: row.status,
                    api: row.api || null,
                    clientIp: row.client_ip || null,
                    clientName: row.client_name || null,
                    outcome: row.outcome || null,
                    reply: row.reply || null,
                    durationMs: row.duration_ms == null ? null : row.duration_ms,
                    calls: row.calls && Array.isArray(row.calls.items) ? row.calls.items : null,
                    callsMore: row.calls && row.calls.more ? row.calls.more : 0
                });
            });
            if (logs[direction].length > REQUEST_LOG_MAX) {
                logs[direction].splice(0, logs[direction].length - REQUEST_LOG_MAX);
            }
        } catch (_) {}
    }
}

// When Lidarr (or anything else) last asked us for something. Background backfill only runs
// once this has been quiet for a while.
let lastInboundAt = 0;
function getLastInboundAt() { return lastInboundAt; }

/**
 * Who is asking, from an Express request: the address it came from, and a name for the client - the label of the API key
 * it used if it used one, otherwise the product named in its User-Agent ("Lidarr", "curl", "python-musicbrainzngs").
 */
function clientOf(req, keyLabel = null) {
    const ip = String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '') || null;
    let name = keyLabel;
    if (!name) {
        const ua = String((req && req.get && req.get('user-agent')) || '').trim();
        const product = ua.split(/[\s/(]/)[0];
        name = ua && !/^mozilla$/i.test(product) ? product.slice(0, 40) : (ua ? 'Browser' : null);
    }
    return { clientIp: ip, clientName: name || null };
}

function persist(entry) {
    if (!_db) return;
    const calls = entry.calls && entry.calls.length ? JSON.stringify({ items: entry.calls, more: entry.callsMore || 0 }) : null;
    _db.query(
        `INSERT INTO request_log (timestamp, direction, label, detail, status, api, client_ip, client_name, outcome, duration_ms, calls, reply)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [entry.timestamp, entry.direction, entry.label, entry.detail, entry.status, entry.api, entry.clientIp, entry.clientName,
         entry.outcome, entry.durationMs, calls, entry.reply]
    ).catch(() => {});
}

function remember(entry) {
    const history = logs[entry.direction] || (logs[entry.direction] = []);
    history.push(entry);
    if (history.length > REQUEST_LOG_MAX) history.shift();
}

/**
 * Record one connection. Inbound rows say who asked (`clientIp`, `clientName`) and which API they used (`api`: 'LMD'
 * for the Lidarr metadata API, 'MB' for /ws/2) and, once answered, how it was answered (`outcome`: "from cache"), what the reply held (`reply`:
 * "6 albums · images: 2 nuLMD") and how long it took (`durationMs`), with the outgoing calls made on the way (taken from the request's context); outbound rows name
 * the service nuLMD called. An outbound call made inside a request is also kept on that request, and is returned as a
 * handle for finishCall (null otherwise).
 */
function logConnection({ direction, label, detail, status = 'ok', api = null, clientIp = null, clientName = null, outcome = null, reply = null, durationMs = null }) {
    if (direction === 'inbound') lastInboundAt = Date.now();
    const store = requestContext.getStore();
    const entry = {
        id: ++requestLogSeq,
        timestamp: new Date().toISOString(),
        direction,
        label,
        detail,
        status,
        api,
        clientIp,
        clientName,
        outcome,
        reply,
        durationMs,
        calls: direction === 'inbound' && store && store.calls.length ? store.calls : null,
        callsMore: direction === 'inbound' && store ? store.more : 0
    };
    remember(entry);
    persist(entry);

    if (direction === 'outbound' && store && !store.closed) {
        if (store.calls.length >= MAX_CALLS) { store.more++; return null; }
        const call = { label, detail, status: 'pending', outcome: null, durationMs: null, startedAt: Date.now() };
        store.calls.push(call);
        return call;
    }
    return null;
}

/** An outgoing call has ended: how it went and how long it took (the time from when it was logged). */
function finishCall(call, { status = 'ok', outcome = null } = {}) {
    if (!call) return;
    call.status = status;
    call.outcome = outcome;
    call.durationMs = Date.now() - call.startedAt;
}

/** How a failed call ended, for finishCall: a 404 is an answer (no cover art, no such record), not a failure. */
function callOutcomeOf(error) {
    const code = error && error.response ? error.response.status : null;
    if (code === 404) return { status: 'ok', outcome: '404' };
    return { status: 'error', outcome: code ? String(code) : ((error && (error.code || error.message)) || 'failed') };
}

/** Finish a call when the request that makes it settles; the request's result passes through unchanged. */
function settleCall(call, request) {
    return Promise.resolve(request).then(
        response => { finishCall(call, { status: 'ok', outcome: response && response.status ? String(response.status) : null }); return response; },
        error => { finishCall(call, callOutcomeOf(error)); throw error; }
    );
}

/** Express middleware: what is called while this request waits is kept on its row, and nothing after it has answered. */
function trackRequest(req, res, next) {
    const store = { calls: [], more: 0, closed: false };
    res.on('close', () => { store.closed = true; });
    requestContext.run(store, next);
}

// ─── Image fetches: one row per burst ───────────────────────────────────────

function imageOutcome(method, code) {
    if (code === 200 || code === 304) return method === 'HEAD' ? 'checked' : 'served';
    if (code === 404) return 'not found';
    return `error: ${code}`;
}

const OUTCOME_ORDER = ['served', 'checked', 'placeholder', 'not found'];

function describeBurst(burst) {
    const { counts, entry } = burst;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const kinds = {};
    for (const f of burst.files.values()) kinds[f.label] = (kinds[f.label] || 0) + (f.count || 1);
    const breakdown = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
    entry.detail = `${total} image${total === 1 ? '' : 's'} (${breakdown})`;
    const errors = Object.keys(counts).filter(k => k.startsWith('error')).reduce((a, k) => a + counts[k], 0);
    const parts = OUTCOME_ORDER.filter(k => counts[k]).map(k => `${counts[k]} ${k}`);
    if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    entry.reply = parts.join(' · ');
    entry.durationMs = burst.lastAt - burst.startedAt;
    // red when any request failed, orange when some covers were not there (the card's existing "partial" colour)
    entry.status = errors ? 'error' : counts['not found'] ? 'cached' : 'ok';
    entry.calls = [...burst.files.values()].slice(0, BURST_MAX_FILES);
    entry.callsMore = Math.max(0, burst.files.size - entry.calls.length);
}

function closeBurst(key) {
    const burst = bursts.get(key);
    if (!burst) return;
    clearTimeout(burst.timer);
    bursts.delete(key);
    describeBurst(burst);
    persist(burst.entry);
}

/** Write out every image burst still open (shutdown, tests). */
function flushImageBursts() {
    for (const key of [...bursts.keys()]) closeBurst(key);
}

function noteImage({ clientIp, clientName, label, detail, method, code, placeholder = false }) {
    const key = `${clientIp}|${clientName}`;
    let burst = bursts.get(key);
    if (burst && Date.now() - burst.startedAt > BURST_MAX_MS) { closeBurst(key); burst = null; }
    if (!burst) {
        const entry = {
            id: ++requestLogSeq, timestamp: new Date().toISOString(), direction: 'inbound', label: 'Image Fetch', detail: '',
            status: 'ok', api: 'LMD', clientIp, clientName, outcome: null, reply: null, durationMs: 0, calls: null, callsMore: 0
        };
        burst = { entry, files: new Map(), counts: {}, startedAt: Date.now(), lastAt: Date.now(), timer: null };
        bursts.set(key, burst);
        remember(entry);
    }
    burst.lastAt = Date.now();

    // The same file asked twice (Lidarr checks with HEAD, then fetches) is one file, and being served wins. The
    // placeholder is one file for every cover that is not there yet, so it keeps a count of how often it was sent.
    const outcome = placeholder ? 'placeholder' : imageOutcome(method, code);
    const statusOf = o => (o.startsWith('error') ? 'error' : o === 'not found' ? 'cached' : 'ok');
    const seen = burst.files.get(detail);
    if (!seen) {
        burst.files.set(detail, { label, detail, status: statusOf(outcome), outcome, durationMs: null, count: 1 });
        burst.counts[outcome] = (burst.counts[outcome] || 0) + 1;
    } else if (placeholder) {
        seen.count++;
        burst.counts.placeholder++;
    } else if (seen.outcome !== 'served') {
        burst.counts[seen.outcome]--;
        seen.outcome = outcome;
        seen.status = statusOf(outcome);
        burst.counts[outcome] = (burst.counts[outcome] || 0) + 1;
    }

    describeBurst(burst);     // the open row shows the totals so far
    clearTimeout(burst.timer);
    burst.timer = setTimeout(() => closeBurst(key), BURST_IDLE_MS);
    if (burst.timer.unref) burst.timer.unref();
}

/**
 * Express middleware for the image files Lidarr pulls from nuLMD (and the placeholder it is sent when a cover is not
 * there yet). The dashboard's own browser loading them is not counted.
 */
function trackImage(req, res, next) {
    const who = clientOf(req);
    if (who.clientName === 'Browser') return next();
    // Read now: Express empties req.params again once the route has finished, before the response has been sent
    const { type, mbid, file } = req.params || {};
    const placeholder = /placeholder\.png$/i.test(req.path);
    res.on('finish', () => {
        try {
            noteImage({
                ...who,
                label: placeholder ? 'placeholder' : String(type || 'image'),
                detail: placeholder ? 'placeholder.png' : `${String(mbid || '').substring(0, 8)}…/${file || ''}`,
                method: req.method,
                code: res.statusCode,
                placeholder
            });
        } catch (_) {}
    });
    next();
}

/** One direction's history (oldest first), or both together in the order things happened. */
function getRequestLog(direction) {
    if (direction) return logs[direction] || [];
    return DIRECTIONS.flatMap(d => logs[d]).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id));
}

module.exports = { init, pruneRequestLog, logConnection, finishCall, settleCall, callOutcomeOf, trackRequest, trackImage, flushImageBursts, clientOf, getRequestLog, getLastInboundAt };
