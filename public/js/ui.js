const JOB_LABELS = {
    fetch_artist:        'Artist Metadata',
    fetch_artist_albums: 'Artist Albums',
    fetch_artist_wiki:   'Artist Bio',
    fetch_artist_images: 'Artist Image URL',
    fetch_release:       'Release Data',
    fetch_album_full:    'Album Releases',
    fetch_album_wiki:    'Album Bio',
    fetch_album_images:  'Album Image URL',
    artist_full:         'Full Artist Fetch',
    artist_releases:     'Artist Releases',
    release_tracks:      'Track Data',
    image_download:      'Image Download',
    backfill_artist:     'MB Backfill · Artist',
    backfill_album:      'MB Backfill · Album'
};

// UI management functions
const ui = {
    refreshInterval: null,
    logPollInterval: null,
    logPaused: false,
    logTailLines: 500,
    currentLogLineCount: 0,

    async refreshDashboard() {
        try {
            const [providers, config] = await Promise.all([
                api.getProviders(),
                api.getConfig()
            ]);
            
            const container = document.getElementById('providerCards');
            
            if (!providers || providers.length === 0) {
                container.innerHTML = '<p>No providers configured</p>';
                return;
            }

            // Build simple provider cards - show ALL active providers
            // Don't filter by config because mandatory providers are always enabled
            const providerIcons = {
                musicbrainz: 'https://musicbrainz.org/static/images/favicons/favicon-32x32.png',
                wikipedia: 'https://www.wikipedia.org/static/favicon/wikipedia.ico',
                coverartarchive: 'https://musicbrainz.org/static/images/favicons/favicon-32x32.png',
                theaudiodb: 'https://www.theaudiodb.com/images/favicon.ico',
                fanart: 'https://fanart.tv/favicon.ico',
                deezer: 'https://www.deezer.com/favicon.ico',
                //lastfm: 'https://www.last.fm/static/images/favicon.ico',
                //discogs: 'https://www.discogs.com/favicon.ico'
            };

            container.innerHTML = providers.map(provider => {
                const icon = providerIcons[provider.name] || '🎵';
                const iconHtml = icon.startsWith('http') 
                    ? `<img src="${icon}" alt="${provider.name}" style="width: 24px; height: 24px;" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline';"><span style="display:none;">🎵</span>`
                    : icon;
                
                return `
                    <div class="provider-card-simple">
                        <div class="provider-icon">${iconHtml}</div>
                        <div class="provider-info">
                            <div class="provider-name">${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)}</div>
                            <div class="provider-status-simple">
                                <span class="status-dot connected"></span>
                                Connected
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        } catch (error) {
            console.error('Failed to refresh dashboard:', error);
            this.showError('Failed to load provider stats');
        }
    },

    async refreshDashboardStats() {
        try {
            const [version, stats] = await Promise.all([
                api.getVersion(),
                api.getStats()
            ]);

            document.getElementById('dashboardVersion').textContent = version.version || '-';
            const footerVersion = document.getElementById('footerVersion');
            if (footerVersion) footerVersion.textContent = `v${version.version}` || 'v?';
            document.getElementById('dashboardUptime').textContent = stats.uptime || '-';
            
            const dbStatus = document.getElementById('dashboardDbStatus');
            if (stats.database.connected) {
                dbStatus.textContent = 'Connected';
                dbStatus.style.color = '#00A65B'; // Lidarr green
            } else {
                dbStatus.textContent = 'Disconnected';
                dbStatus.style.color = '#f05050'; // Lidarr red
            }
            
            document.getElementById('dashboardActiveJobs').textContent = stats.jobs.active + stats.jobs.pending;

            // Lidarr status
            const lidarrEl = document.getElementById('dashboardLidarrStatus');
            try {
                const lidarrStatus = await fetch('/api/lidarr/status').then(r => r.json());
                if (lidarrStatus.enabled && lidarrStatus.connected) {
                    lidarrEl.textContent = 'Connected';
                    lidarrEl.style.color = '#00A65B';
                } else if (lidarrStatus.enabled) {
                    lidarrEl.textContent = 'Disconnected';
                    lidarrEl.style.color = '#f05050';
                } else {
                    lidarrEl.textContent = 'Not Configured';
                    lidarrEl.style.color = 'var(--text-secondary)';
                }
            } catch (e) {
                lidarrEl.textContent = 'Unknown';
                lidarrEl.style.color = 'var(--text-secondary)';
            }
            document.getElementById('dashboardArtistCount').textContent = stats.database.artists.toLocaleString();
            const catalogs = stats.database.catalogs;
            if (catalogs) {
                const parts = [];
                if (catalogs.verified) parts.push(`${catalogs.verified.toLocaleString()} checked`);
                if (catalogs.unverified) parts.push(`${catalogs.unverified.toLocaleString()} older`);
                if (catalogs.provisional) parts.push(`${catalogs.provisional.toLocaleString()} provisional`);
                if (catalogs.incomplete) parts.push(`${catalogs.incomplete.toLocaleString()} incomplete`);
                const el = document.getElementById('dashboardCatalogs');
                el.textContent = parts.join(' · ');
                el.title = 'Catalogs: checked = verified against MusicBrainz; older = stored before that check, renewed at their TTL; provisional = taken from an upstream while MusicBrainz was down; incomplete = not fetched yet';
            }
            document.getElementById('dashboardAlbumCount').textContent = stats.database.albums.toLocaleString();
            document.getElementById('dashboardReleaseCount').textContent = stats.database.releases.toLocaleString();
            document.getElementById('dashboardTrackCount').textContent = stats.database.tracks.toLocaleString();
            const imgMb = stats.database.images_mb;
            const imgSize = imgMb >= 1024
                ? `${(imgMb / 1024).toFixed(1)} GB`
                : `${imgMb} MB`;
            document.getElementById('dashboardImageCount').textContent = stats.database.images.toLocaleString();
            document.getElementById('dashboardImageSize').textContent = imgSize;
        } catch (error) {
            console.error('Failed to refresh dashboard stats:', error);
        }
    },



    formatLogLine(log) {
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const levelClass = `log-level-${log.level}`;
        
        return `
            <div class="log-line">
                <span class="log-timestamp">[${timestamp}]</span>
                <span class="${levelClass}">${log.level.toUpperCase()}</span>: 
                <span class="log-message">${this.escapeHtml(log.message)}</span>
            </div>
        `;
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    async loadMetadataSources() {
        this.loadSourcesEditor();
        const container = document.getElementById('metadataSourcesForm');
        container.innerHTML = '<p>Loading metadata sources...</p>';

        try {
            const config = await api.getConfig();
            
            let html = '';

            // Skip mandatory providers and non-functional providers
            // (MusicBrainz is managed in the Metadata Servers card above)
            const skipProviders = ['wikipedia', 'theaudiodb', 'musicbrainz'];

            // Create cards for each provider
            for (const [name, settings] of Object.entries(config.providers || {})) {
                // Skip providers
                if (skipProviders.includes(name)) continue;

                const providerName = name.charAt(0).toUpperCase() + name.slice(1);
                
                html += `<div class="card" style="margin-bottom: 15px;">`;
                html += `<h3>${providerName}</h3>`;
                
                {
                    // Other providers: Show enable toggle. Fanart has none: it is on when it has a key (the environment's wins)
                    if (name === 'fanart') {
                        html += '<small class="form-text" style="display:block; margin-bottom: 0.75rem;">';
                        html += settings.enabled ? 'On. Remove the key and restart the server to turn it off.' : 'Enter API key to enable';
                        if (settings.apiKeyFromEnv) html += ' The key is set by FANART_API_KEY in the environment and can only be changed in the compose file.';
                        html += '</small>';
                    } else {
                        html += '<div class="form-group">';
                        html += `<label for="providers.${name}.enabled">`;
                        html += `<input type="checkbox" id="providers.${name}.enabled" `;
                        html += `${settings.enabled ? 'checked' : ''}> Enabled`;
                        html += '</label>';
                        html += '</div>';
                    }

                    // API Key field — show for any provider that has apiKey, token, or clientSecret in config,
                    // or for known providers that need keys
                    const needsApiKey = ['fanart', 'lastfm', 'discogs'];
                    if (settings.apiKey !== undefined || needsApiKey.includes(name)) {
                        html += '<div class="form-group">';
                        html += `<label for="providers.${name}.apiKey">API Key</label>`;
                        const displayValue = settings.apiKey && settings.apiKey !== '' ? settings.apiKey : '';
                        html += `<input type="text" class="form-control" id="providers.${name}.apiKey" value="${displayValue}" placeholder="Enter API key"${settings.apiKeyFromEnv ? ' disabled' : ''}>`;
                        html += '</div>';
                    }
                }
                
                html += '</div>';
            }

            html += '<div style="display: flex; gap: 10px;">';
            html += '<button class="btn btn-primary" onclick="ui.saveMetadataSources()">Save Configuration</button>';
            html += '</div>';
            
            container.innerHTML = html;
        } catch (error) {
            console.error('Failed to load metadata sources:', error);
            container.innerHTML = '<p class="alert alert-danger">Failed to load metadata sources</p>';
        }
    },

    // ─── Metadata servers (MusicBrainz sources + Lidarr metadata upstreams) ─────────

    sourcesModel: [],
    sourcesDirty: false,
    sourcesPollTimeout: null,
    _backfillInfo: null,
    _backfillFetchedAt: 0,

    hostOf(url) {
        return String(url || '').replace(/^https?:\/\//i, '').split('/')[0] || url || '';
    },

    // Politeness policy. Mirrors server/lib/mbSources.js, which is the authority and enforces it on save;
    // this just keeps the form honest as you type. The three big public servers (official MusicBrainz,
    // the official Lidarr metadata server, brainzmash) are fixed at 1 request / 2 s, one at a time.
    // Any other remote server defaults to 2 s but can be changed.
    _hostOf(url) {
        const m = String(url || '').trim().match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i);
        return m ? m[1].replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '') : '';
    },

    protectedDomain(url) {
        const host = this._hostOf(url);
        return ['musicbrainz.org', 'lidarr.audio', 'brainzmash.cc'].find(d => host === d || host.endsWith('.' + d)) || null;
    },

    isLocalHost(url) {
        const host = this._hostOf(url);
        if (!host) return false;
        if (host === 'localhost' || /\.(localhost|local|lan|internal|home\.arpa)$/.test(host)) return true;
        if (!host.includes('.') && !host.includes(':')) return true;
        const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (v4) {
            const a = Number(v4[1]), b = Number(v4[2]);
            return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
                (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
        }
        if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
        return false;
    },

    // What the form should do for this URL: locked values, or defaults the user may change
    policyFor(url, type) {
        const domain = this.protectedDomain(url);
        if (domain) {
            const names = { 'musicbrainz.org': 'Official MusicBrainz', 'lidarr.audio': 'Official Lidarr metadata', 'brainzmash.cc': 'Community brainzmash' };
            return { locked: true, rate: 2000, par: 1,
                note: `${names[domain]} server: fixed at 1 request every 2 seconds, one at a time. This protects a shared public resource.` };
        }
        const remote = String(url || '').trim() !== '' && !this.isLocalHost(url);
        const rate = remote ? 2000 : (type === 'lmd' ? 1000 : 0);
        const par = remote ? 2 : (type === 'lmd' ? 2 : 4);
        return { locked: false, rate, par,
            note: remote ? 'Remote server: defaults to 1 request every 2 seconds. Please be kind to servers you don\'t run.' : '' };
    },

    // Bring a row's rate/parallel inputs in line with the policy for its URL
    _applyPolicy(i) {
        const s = this.sourcesModel[i];
        const row = document.querySelector(`#sourcesEditor .src-row[data-src="${i}"]`);
        if (!s || !row) return;
        const policy = this.policyFor(s.url, s.type);
        const rate = row.querySelector('.src-rate');
        const par = row.querySelector('.src-par');
        if (!s.fromEnv) {
            if (policy.locked) {
                s.rateLimitMs = policy.rate;
                s.maxConcurrent = policy.par;
                s._wasLocked = true;
            } else if (s._wasLocked || s._auto) {
                // Left a locked/auto-filled state: go back to the defaults for this kind of URL
                s.rateLimitMs = policy.rate;
                s.maxConcurrent = policy.par;
                s._wasLocked = false;
            }
        }
        if (rate) { rate.value = s.rateLimitMs ?? ''; rate.disabled = !!s.fromEnv || policy.locked; }
        if (par) { par.value = s.maxConcurrent ?? ''; par.disabled = !!s.fromEnv || policy.locked; }
        const note = row.querySelector('.src-note');
        if (note) note.textContent = policy.note;
    },

    // Once you set a value yourself, stop auto-filling it
    srcCommit(i, field, el) {
        const s = this.sourcesModel[i];
        if (s) s._auto = false;
        this.srcSet(i, field, el.value);
    },

    async loadSourcesEditor() {
        const container = document.getElementById('sourcesEditor');
        if (!container) return;
        if (this.sourcesDirty) { this.startSourcesPolling(); return; } // don't wipe unsaved edits
        try {
            const data = await api.get('/sources');
            this.sourcesModel = data.sources.map(s => ({ ...s }));
            this.renderSourcesEditor();
            this.startSourcesPolling();
        } catch (error) {
            console.error('Failed to load metadata servers:', error);
            container.innerHTML = '<p class="alert alert-danger">Failed to load metadata servers</p>';
        }
    },

    renderSourcesEditor() {
        const container = document.getElementById('sourcesEditor');
        if (!container) return;
        const rows = this.sourcesModel.map((s, i) => this._sourceRowHtml(s, i)).join('');
        container.innerHTML = `
            ${rows || '<div class="src-empty">No servers configured</div>'}
            <div class="src-editor-actions">
                <button class="btn btn-secondary btn-sm" onclick="ui.addSource('musicbrainz')">+ MusicBrainz server</button>
                <button class="btn btn-secondary btn-sm" onclick="ui.addSource('lmd')">+ Lidarr metadata server</button>
                <span style="flex:1"></span>
                <span class="src-dirty" id="sourcesDirty" ${this.sourcesDirty ? '' : 'hidden'}>Unsaved changes</span>
                <button class="btn btn-primary" onclick="ui.saveSources()">Save &amp; Apply</button>
            </div>
            <div class="src-hint">Changes apply immediately, no restart needed. MusicBrainz always stays in the mix: it is the authority, answers anything a Lidarr metadata server can't, and fills in missing details when nuLMD is idle. The shared public servers (official MusicBrainz, the official Lidarr server and brainzmash) are fixed at one request every 2 seconds; other remote servers default to the same but you can change it.</div>`;
    },

    _sourceRowHtml(s, i) {
        const e = v => this.escapeHtml(String(v ?? '')).replace(/"/g, '&quot;');
        const locked = !!s.fromEnv;
        const policy = this.policyFor(s.url, s.type);
        const official = !!s.isOfficial;
        const lmd = s.type === 'lmd';
        const dis = locked ? 'disabled' : '';
        const badges = [
            `<span class="src-badge ${lmd ? 'lmd' : ''}">${lmd ? 'LMD' : 'MusicBrainz'}</span>`,
            locked ? '<span class="src-badge env" title="Set by an environment variable in your compose file; edit it there">compose</span>' : '',
            policy.locked ? '<span class="src-badge" title="Shared public server: fixed at 1 request every 2 seconds">public · 2s fixed</span>' : ''
        ].join(' ');
        return `
        <div class="src-row ${locked ? 'is-env' : ''}" data-src="${i}">
            <div class="src-row-main">
                <label class="src-toggle"><input type="checkbox" ${s.enabled ? 'checked' : ''} ${dis} onchange="ui.srcSet(${i}, 'enabled', this.checked)"> On</label>
                <div class="src-field">
                    <label>Type</label>
                    <select class="form-control" ${s.new ? '' : 'disabled'} onchange="ui.srcSet(${i}, 'type', this.value)">
                        <option value="musicbrainz" ${!lmd ? 'selected' : ''}>MusicBrainz</option>
                        <option value="lmd" ${lmd ? 'selected' : ''}>Lidarr metadata</option>
                    </select>
                </div>
                <div class="src-field url">
                    <label>URL</label>
                    <input type="text" class="form-control" value="${e(s.url)}" ${dis} placeholder="${lmd ? 'https://api.lidarr.audio/api/v0.4' : 'http://localhost:5000/ws/2'}" oninput="ui.srcSet(${i}, 'url', this.value); ui._applyPolicy(${i})">
                </div>
                <div class="src-field">
                    <label title="Lower is tried first. Same number = take turns.">Priority</label>
                    <input type="number" class="form-control" min="1" max="99" value="${e(s.priority)}" ${dis} oninput="ui.srcSet(${i}, 'priority', this.value)">
                </div>
                <div class="src-field">
                    <label title="Minimum milliseconds between requests. 0 = no limit.">Rate limit (ms)</label>
                    <input type="number" class="form-control src-rate" min="0" value="${e(s.rateLimitMs)}" ${locked || policy.locked ? 'disabled' : ''} onchange="ui.srcCommit(${i}, 'rateLimitMs', this)">
                </div>
                <div class="src-field">
                    <label title="How many requests may be in flight at once.">Max parallel</label>
                    <input type="number" class="form-control src-par" min="1" max="32" value="${e(s.maxConcurrent)}" ${locked || policy.locked ? 'disabled' : ''} onchange="ui.srcCommit(${i}, 'maxConcurrent', this)">
                </div>
                <div class="src-row-actions">
                    <button class="btn btn-secondary btn-sm" onclick="ui.testSource(${i})">Test</button>
                    ${locked ? '' : `<button class="btn btn-danger btn-sm" onclick="ui.removeSource(${i})">Remove</button>`}
                </div>
            </div>
            <div class="src-row-foot">
                <span class="src-dot ${s.enabled ? '' : 'disabled'}" id="srcDot${i}"></span>
                ${badges}
                <span id="srcLive${i}"></span>
                <span class="src-test-result" id="srcTest${i}"></span>
                <span class="src-note">${this.escapeHtml(policy.note)}</span>
            </div>
        </div>`;
    },

    srcSet(i, field, value) {
        const s = this.sourcesModel[i];
        if (!s) return;
        if (field === 'type') {
            s.type = value;
            if (s.new) { const p = this.policyFor(s.url, value); s.rateLimitMs = p.rate; s.maxConcurrent = p.par; s._auto = true; }
            this.sourcesDirty = true;
            this.renderSourcesEditor();
            return;
        }
        s[field] = value;
        this.sourcesDirty = true;
        const flag = document.getElementById('sourcesDirty');
        if (flag) flag.hidden = false;
    },

    addSource(type) {
        this.sourcesModel.push({
            type, url: '', priority: 1, enabled: true, fromEnv: false, isOfficial: false, new: true,
            rateLimitMs: type === 'lmd' ? 1000 : 0, maxConcurrent: type === 'lmd' ? 2 : 4, live: null, _auto: true
        });
        this.sourcesDirty = true;
        this.renderSourcesEditor();
        const urls = document.querySelectorAll('#sourcesEditor .src-field.url input');
        if (urls.length) urls[urls.length - 1].focus();
    },

    removeSource(i) {
        const s = this.sourcesModel[i];
        if (!s) return;
        if (s.url && !confirm(`Remove ${s.url}?`)) return;
        this.sourcesModel.splice(i, 1);
        this.sourcesDirty = true;
        this.renderSourcesEditor();
    },

    async testSource(i) {
        const s = this.sourcesModel[i];
        const out = document.getElementById(`srcTest${i}`);
        if (!s || !out) return;
        if (!String(s.url || '').trim()) { out.className = 'src-test-result bad'; out.textContent = 'Enter a URL first'; return; }
        out.className = 'src-test-result';
        out.textContent = 'Testing…';
        try {
            const r = await api.post('/sources/test', { url: s.url, type: s.type });
            out.className = `src-test-result ${r.ok ? 'ok' : 'bad'}`;
            out.textContent = r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`;
        } catch (error) {
            out.className = 'src-test-result bad';
            out.textContent = `✗ ${error.message}`;
        }
    },

    async saveSources() {
        try {
            // A URL already set by compose can't also be managed here: the environment wins
            const envUrls = new Set(this.sourcesModel.filter(s => s.fromEnv).map(s => String(s.url).replace(/\/+$/, '').toLowerCase()));
            const clash = this.sourcesModel.find(s => !s.fromEnv && envUrls.has(String(s.url || '').trim().replace(/\/+$/, '').toLowerCase()));
            if (clash) {
                this.showError(`${clash.url} is already set in your compose file; edit or remove it there`);
                return;
            }
            const payload = this.sourcesModel.filter(s => !s.fromEnv).map(s => {
                const entry = { type: s.type, url: String(s.url || '').trim(), priority: s.priority, enabled: !!s.enabled };
                if (!this.policyFor(s.url, s.type).locked) {
                    if (s.rateLimitMs !== '' && s.rateLimitMs !== undefined && s.rateLimitMs !== null) entry.rateLimitMs = s.rateLimitMs;
                    if (s.maxConcurrent !== '' && s.maxConcurrent !== undefined && s.maxConcurrent !== null) entry.maxConcurrent = s.maxConcurrent;
                }
                if (s.enabledOps) entry.enabledOps = s.enabledOps;
                return entry;
            });
            const result = await api.request('/sources', { method: 'PUT', body: JSON.stringify({ sources: payload }) });
            this.sourcesDirty = false;
            this.showSuccess('Metadata servers applied');
            (result.adjusted || []).forEach(note => this.showMessage(note, 'info'));
            await this.loadSourcesEditor();
            this.refreshSourcesStrip();
        } catch (error) {
            this.showError(error.message || 'Failed to save metadata servers');
        }
    },

    _liveText(s, live) {
        if (!s.enabled) return 'Disabled';
        if (!live) return s.new ? 'Not active until you save' : 'Not active yet';
        const state = { closed: 'Healthy', 'half-open': 'Testing after failures', open: 'Paused after repeated failures' }[live.breaker] || live.breaker;
        const bits = [state, `${live.inflight} in flight`, `${live.served} served`, `${live.failed} failed`];
        return bits.join(' · ');
    },

    _liveDot(s, live) {
        if (!s.enabled) return 'disabled';
        if (!live) return 'disabled';
        if (live.breaker === 'closed' && live.inflight > 0) return 'busy';
        return live.breaker;
    },

    startSourcesPolling() {
        if (this.sourcesPollTimeout) clearTimeout(this.sourcesPollTimeout);
        const tick = async () => {
            const tab = document.getElementById('sources-tab');
            if (!tab || !tab.classList.contains('active')) { this.sourcesPollTimeout = null; return; }
            try {
                const data = await api.get('/sources');
                const liveByUrl = new Map(data.sources.map(s => [String(s.url).replace(/\/+$/, '').toLowerCase(), s.live]));
                this.sourcesModel.forEach((s, i) => {
                    const live = s.new ? null : liveByUrl.get(String(s.url || '').replace(/\/+$/, '').toLowerCase()) || null;
                    s.live = live;
                    const text = document.getElementById(`srcLive${i}`);
                    const dot = document.getElementById(`srcDot${i}`);
                    if (text) {
                        text.innerHTML = this.escapeHtml(this._liveText(s, live)) +
                            (live && live.lastError ? ` <span class="src-err" title="${this.escapeHtml(live.lastError).replace(/"/g, '&quot;')}">· ${this.escapeHtml(live.lastError.slice(0, 90))}</span>` : '');
                    }
                    if (dot) dot.className = `src-dot ${this._liveDot(s, live)}`;
                });
            } catch (_) { /* transient; try again */ }
            this.sourcesPollTimeout = setTimeout(tick, 2000);
        };
        tick();
    },

    // Compact per-source status above the Database Jobs list
    async refreshSourcesStrip() {
        const el = document.getElementById('sourcesStrip');
        if (!el) return;
        try {
            const data = await api.get('/sources');
            const now = Date.now();
            if (now - this._backfillFetchedAt > 10000) {
                this._backfillFetchedAt = now;
                try { this._backfillInfo = await api.get('/backfill'); } catch (_) { /* keep last */ }
            }
            const bf = this._backfillInfo;
            const waiting = bf ? (bf.artists + bf.albums) : 0;
            const showBackfill = !!bf && (waiting > 0 || bf.queued > 0 || bf.running > 0);

            if (data.sources.length < 2 && !showBackfill) { el.hidden = true; return; }

            const chips = data.sources.length < 2 ? [] : data.sources.map(s => {
                const live = s.live;
                const dot = this._liveDot(s, live);
                const state = !s.enabled ? 'disabled' : (live ? live.breaker : 'inactive');
                const meta = live ? `${live.inflight ? live.inflight + ' active · ' : ''}${live.served} served${live.failed ? ' · ' + live.failed + ' failed' : ''}` : (s.enabled ? 'starting' : 'off');
                const tip = [s.url, live && live.lastError ? `Last error: ${live.lastError}` : ''].filter(Boolean).join('\n');
                return `<div class="src-chip ${state === 'open' ? 'is-open' : ''} ${!s.enabled ? 'is-disabled' : ''}" title="${this.escapeHtml(tip).replace(/"/g, '&quot;')}">
                    <span class="src-dot ${dot}"></span>
                    <span class="src-host">${this.escapeHtml(this.hostOf(s.url))}</span>
                    <span class="src-badge ${s.type === 'lmd' ? 'lmd' : ''}">${s.type === 'lmd' ? 'LMD' : 'MB'}</span>
                    <span class="src-meta">P${s.priority} · ${this.escapeHtml(meta)}</span>
                </div>`;
            });

            if (showBackfill) {
                const state = bf.running > 0 ? 'filling gaps from MusicBrainz' : (bf.idle ? 'starting soon' : 'waiting for quiet');
                chips.push(`<div class="src-chip backfill" title="Rows from a Lidarr metadata server are filled in from MusicBrainz when nuLMD is idle">
                    <span class="src-dot ${bf.running > 0 ? 'busy' : 'disabled'}"></span>
                    <span class="src-host">MB backfill</span>
                    <span class="src-meta">${waiting} waiting${bf.queued ? ' · ' + bf.queued + ' queued' : ''} · ${state}</span>
                </div>`);
            }
            el.innerHTML = chips.join('');
            el.hidden = false;
        } catch (_) { /* leave as is */ }
    },

    // ── MusicBrainz API keys (/ws/2) ────────────────────────────────────────────

    async loadWs2Keys() {
        const status = document.getElementById('ws2KeysStatus');
        const list = document.getElementById('ws2KeysList');
        const endpoint = document.getElementById('ws2Endpoint');
        if (!status || !list) return;
        if (endpoint) endpoint.textContent = `${location.origin}/ws/2`;
        try {
            const { keys, open } = await api.get('/ws2/keys');
            status.innerHTML = open
                ? '<span><b>Open</b>No keys yet: anyone who can reach this address can use it</span>'
                : `<span><b>${keys.length}</b>${keys.length === 1 ? 'key' : 'keys'}</span><span>A key is required on every request</span>`;
            const when = d => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
            list.innerHTML = keys.length === 0 ? '' : `
                <div class="key-row key-head"><span>Name</span><span>Key</span><span>Created</span><span>Last used</span><span>Requests</span><span></span></div>
                ${keys.map(k => `
                <div class="key-row">
                    <span class="key-name">${this.escapeHtml(k.label)}</span>
                    <span class="key-prefix"><code>${this.escapeHtml(k.prefix)}</code></span>
                    <span>${k.env ? 'environment' : when(k.createdAt)}</span>
                    <span>${k.env ? '—' : when(k.lastUsedAt)}</span>
                    <span>${k.requestCount === null ? '—' : k.requestCount}</span>
                    <span>${k.env ? '' : `<button class="btn btn-danger btn-sm" onclick="ui.deleteWs2Key('${k.id}')">Remove</button>`}</span>
                </div>`).join('')}`;
        } catch (error) {
            status.textContent = 'Failed to load the API keys';
        }
    },

    async createWs2Key() {
        const input = document.getElementById('ws2.keyLabel');
        const label = input.value.trim();
        if (!label) { this.showError('Give the key a name first'); return; }
        try {
            const created = await api.post('/ws2/keys', { label });
            input.value = '';
            const box = document.getElementById('ws2NewKey');
            document.getElementById('ws2NewKeyValue').value = created.key;
            box.hidden = false;
            document.getElementById('ws2NewKeyValue').select();
            this.loadWs2Keys();
        } catch (error) {
            this.showError(error.message || 'Failed to make the key');
        }
    },

    copyWs2Key() {
        const field = document.getElementById('ws2NewKeyValue');
        field.select();
        // The clipboard API only exists on secure pages (https or localhost); nuLMD is often plain http on a LAN
        const done = () => this.showSuccess('Key copied');
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(field.value).then(done, () => document.execCommand('copy') && done());
        else if (document.execCommand('copy')) done();
        else this.showError('Select the key and copy it by hand');
    },

    async deleteWs2Key(id) {
        if (!confirm('Remove this key?\n\nAnything still using it stops working straight away. This cannot be undone.')) return;
        try {
            await api.delete(`/ws2/keys/${id}`);
            document.getElementById('ws2NewKey').hidden = true;
            this.showSuccess('Key removed');
            this.loadWs2Keys();
        } catch (error) {
            this.showError(error.message || 'Failed to remove the key');
        }
    },

    async loadMetadataBrowser() {
        // Check Lidarr integration status for conditional UI
        try {
            const lidarrStatus = await fetch('/api/lidarr/status').then(r => r.json());
            this.lidarrEnabled = lidarrStatus.enabled && lidarrStatus.connected;
        } catch (e) {
            this.lidarrEnabled = false;
        }

        // Load metadata tree
        await this.loadMetadataTree();
    },

    async loadMetadataTree() {
        const container = document.getElementById('metadataTree');
        container.innerHTML = '<p>Loading metadata...</p>';

        try {
            const response = await fetch('/api/metadata/artists');
            const artists = await response.json();

            if (artists.length === 0) {
                container.innerHTML = '<p>No artists in database</p>';
                return;
            }

            // Build table HTML
            let html = `
                <div class="metadata-search" style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: nowrap;">
                    <input type="text" id="metadataSearchInput" placeholder="Search artists..." onkeyup="ui.filterMetadataTree()" style="flex: 1; min-width: 150px; max-width: 300px;">
                    <select id="albumTypeFilter" onchange="ui.applyFilters()" style="padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
                        <option value="all">All Types</option>
                        <option value="Album" selected>Studio Albums</option>
                        <option value="EP">EPs</option>
                        <option value="Single">Singles</option>
                        <option value="Live">Live</option>
                        <option value="Compilation">Compilations</option>
                        <option value="Soundtrack">Soundtracks</option>
                        <option value="Spokenword">Spokenword</option>
                        <option value="Interview">Interviews</option>
                        <option value="Audiobook">Audiobooks</option>
                        <option value="Audio drama">Audio Dramas</option>
                        <option value="Remix">Remixes</option>
                        <option value="DJ-mix">DJ Mixes</option>
                        <option value="Mixtape/Street">Mixtapes</option>
                        <option value="Demo">Demos</option>
                    </select>
                    <select id="releaseStatusFilter" onchange="ui.applyFilters()" style="padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
                        <option value="all">All Release Types</option>
                        <option value="Official" selected>Official Only</option>
                        <option value="Promotion">Promotional Only</option>
                        <option value="Bootleg">Bootleg Only</option>
                    </select>
                    <select id="emptyArtistFilter" onchange="ui.applyFilters()" style="padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
                        <option value="hide" selected>Hide Empty Artists</option>
                        <option value="show">Show Empty Artists</option>
                    </select>
                </div>
                <div class="metadata-table-wrapper">
                    <table class="metadata-table">
                        <thead>
                            <tr>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('name')">Name</th>
                                <th>MBID</th>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('type')">Type</th>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('country')">Country</th>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('album_count')">Albums</th>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('release_count')">Releases</th>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('track_count')">Tracks</th>
                                <th class="sortable" onclick="event.stopPropagation(); ui.sortMetadataTree('last_updated_at')">Last Updated</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="metadataTableBody">
            `;

            // Add artist rows
            for (const artist of artists) {
                const lastUpdated = artist.last_updated_at ? new Date(artist.last_updated_at).toLocaleDateString() + ' ' + new Date(artist.last_updated_at).toLocaleTimeString() : 'Never';
                
                html += `
                    <tr class="level-0 artist-row" data-artist-id="${artist.mbid}" data-name="${artist.name.toLowerCase()}">
                        <td>
                            <span class="expand-icon" onclick="ui.toggleArtistExpand('${artist.mbid}')">▶</span>
                            ${this.escapeHtml(artist.name)}${this.catalogBadge(this.catalogStateOf(artist))}
                        </td>
                        <td><a href="https://musicbrainz.org/artist/${artist.mbid}" target="_blank" class="mbid-link" onclick="event.stopPropagation()" title="View on MusicBrainz">${artist.mbid.substring(0, 8)}...</a></td>
                        <td>${artist.type || '-'}</td>
                        <td>${artist.country || '-'}</td>
                        <td>${artist.album_count}</td>
                        <td>${artist.release_count}</td>
                        <td>${artist.track_count}</td>
                        <td>${lastUpdated}</td>
                        <td>
                            <button class="btn-refresh" onclick="ui.refreshArtistMetadata('${artist.mbid}')">Fetch</button>
                            <button class="btn-refresh danger" onclick="ui.clearMetadata('artist', '${artist.mbid}', this)">Clear</button>
                            <button class="btn-refresh danger" onclick="ui.blockMetadata('artist', '${artist.mbid}', this)">Block</button>
                            ${this.lidarrEnabled ? `<button class="btn-refresh" style="margin-left:0.25rem;" onclick="ui.refreshInLidarr('${artist.mbid}', this)">Refresh in Lidarr</button>` : ''}
                        </td>
                    </tr>
                `;
            }

            html += `
                        </tbody>
                    </table>
                </div>
            `;

            container.innerHTML = html;

            // Sort alphabetically and rebuild
            artists.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
            this.metadataArtists = artists;
            this.metadataSort = { column: 'name', direction: 'asc' };
            this.currentAlbumTypeFilter = this.currentAlbumTypeFilter || 'Album';
            this.currentReleaseStatusFilter = this.currentReleaseStatusFilter || 'Official';
            this.hideEmptyArtists = this.hideEmptyArtists ?? true;
            this.rebuildMetadataTable();

        } catch (error) {
            console.error('Failed to load metadata tree:', error);
            container.innerHTML = '<p class="alert alert-danger">Failed to load metadata</p>';
        }
    },

    async toggleArtistExpand(artistMbid) {
        const row = document.querySelector(`tr[data-artist-id="${artistMbid}"]`);
        const icon = row.querySelector('.expand-icon');
        
        // Check if already expanded
        if (icon.classList.contains('expanded')) {
            // Collapse: remove album rows AND their track rows
            icon.classList.remove('expanded');
            const albumRows = document.querySelectorAll(`tr[data-parent-artist="${artistMbid}"]`);
            albumRows.forEach(albumRow => {
                // If this album was expanded, also remove its tracks
                const albumId = albumRow.getAttribute('data-album-id');
                if (albumId) {
                    const trackRows = document.querySelectorAll(`tr[data-parent-album="${albumId}"]`);
                    trackRows.forEach(tr => tr.remove());
                }
                albumRow.remove();
            });
            return;
        }

        // Expand: fetch and display albums
        icon.classList.add('expanded');
        
        try {
            const response = await fetch(`/api/metadata/artist/${artistMbid}`);
            const data = await response.json();
            const albums = data.albums;

            if (albums.length === 0) {
                // Insert "no albums" row
                const noAlbumsRow = document.createElement('tr');
                noAlbumsRow.className = 'level-1';
                noAlbumsRow.setAttribute('data-parent-artist', artistMbid);
                noAlbumsRow.innerHTML = '<td colspan="9" style="color: var(--text-secondary); font-style: italic;">No albums</td>';
                row.insertAdjacentElement('afterend', noAlbumsRow);
                return;
            }

            // Filter albums by type and release status
            const typeFilter = this.currentAlbumTypeFilter || 'Album';
            const statusFilter = this.currentReleaseStatusFilter || 'Official';
            
            let filteredAlbums = albums;
            
            // Apply type filter
            if (typeFilter !== 'all') {
                filteredAlbums = filteredAlbums.filter(a => {
                    const secondaryTypes = a.secondary_types || [];
                    
                    // For "Album" filter, show pure studio albums (no secondary types that change the nature)
                    if (typeFilter === 'Album') {
                        return a.primary_type === 'Album' && 
                               !secondaryTypes.includes('Live') && 
                               !secondaryTypes.includes('Compilation') &&
                               !secondaryTypes.includes('Soundtrack') &&
                               !secondaryTypes.includes('Spokenword') &&
                               !secondaryTypes.includes('Interview') &&
                               !secondaryTypes.includes('Audiobook') &&
                               !secondaryTypes.includes('Audio drama') &&
                               !secondaryTypes.includes('DJ-mix') &&
                               !secondaryTypes.includes('Mixtape/Street') &&
                               !secondaryTypes.includes('Demo');
                    }
                    
                    // For secondary type filters (Live, Compilation, Soundtrack, etc.)
                    // Check if the type appears in secondary_types
                    const secondaryTypeFilters = ['Live', 'Compilation', 'Soundtrack', 'Spokenword', 
                                                 'Interview', 'Audiobook', 'Audio drama', 'Remix', 
                                                 'DJ-mix', 'Mixtape/Street', 'Demo'];
                    if (secondaryTypeFilters.includes(typeFilter)) {
                        return secondaryTypes.includes(typeFilter);
                    }
                    
                    // For primary type filters (EP, Single, Broadcast, Other)
                    // Match primary_type
                    return a.primary_type === typeFilter;
                });
            }
            
            // Apply status filter (only if not 'all')
            if (statusFilter !== 'all') {
                filteredAlbums = filteredAlbums.filter(a => {
                    // If no releases fetched yet, treat as 'Official' (assume it will be Official when fetched)
                    const status = a.first_release_status || 'Official';
                    return status === statusFilter;
                });
            }

            if (filteredAlbums.length === 0) {
                const noAlbumsRow = document.createElement('tr');
                noAlbumsRow.className = 'level-1';
                noAlbumsRow.setAttribute('data-parent-artist', artistMbid);
                const typeLabel = typeFilter === 'all' ? '' : typeFilter + ' ';
                const statusLabel = statusFilter === 'all' ? '' : statusFilter + ' ';
                noAlbumsRow.innerHTML = `<td colspan="9" style="color: var(--text-secondary); font-style: italic;">No ${statusLabel}${typeLabel}albums found in database, try fetching from MusicBrainz...</td>`;
                row.insertAdjacentElement('afterend', noAlbumsRow);
                return;
            }

            // Insert album rows after artist row
            let insertAfter = row;
            for (const album of filteredAlbums) {
                const albumRow = document.createElement('tr');
                albumRow.className = 'level-1 album-row';
                albumRow.setAttribute('data-parent-artist', artistMbid);
                albumRow.setAttribute('data-album-id', album.mbid);
                
                const releaseDate = album.first_release_date ? new Date(album.first_release_date).toLocaleDateString() : 'Unknown';
                
                albumRow.innerHTML = `
                    <td>
                        <span class="expand-icon" onclick="ui.toggleAlbumExpand('${album.mbid}')">▶</span>
                        ${this.escapeHtml(album.title)}
                    </td>
                    <td><a href="https://musicbrainz.org/release-group/${album.mbid}" target="_blank" class="mbid-link" onclick="event.stopPropagation()" title="View on MusicBrainz">${album.mbid.substring(0, 8)}...</a></td>
                    <td>${album.primary_type || '-'}</td>
                    <td>${releaseDate}</td>
                    <td>${album.release_count}</td>
                    <td>${album.track_count}</td>
                    <td colspan="2"></td>
                    <td>
                        <button class="btn-refresh" onclick="event.stopPropagation(); ui.refreshAlbumMetadata('${album.mbid}', '${artistMbid}')">Fetch</button>
                        <button class="btn-refresh danger" onclick="event.stopPropagation(); ui.clearMetadata('release_group', '${album.mbid}', this)">Clear</button>
                        <button class="btn-refresh danger" onclick="event.stopPropagation(); ui.blockMetadata('release_group', '${album.mbid}', this)">Block</button>
                    </td>
                `;
                
                insertAfter.insertAdjacentElement('afterend', albumRow);
                insertAfter = albumRow;
            }

        } catch (error) {
            console.error('Failed to load albums:', error);
            this.showError('Failed to load albums');
        }
    },

    async toggleAlbumExpand(albumMbid) {
        const row = document.querySelector(`tr[data-album-id="${albumMbid}"]`);
        const icon = row.querySelector('.expand-icon');
        
        // Check if already expanded
        if (icon.classList.contains('expanded')) {
            // Collapse: remove track rows
            icon.classList.remove('expanded');
            const trackRows = document.querySelectorAll(`tr[data-parent-album="${albumMbid}"]`);
            trackRows.forEach(r => r.remove());
            return;
        }

        // Expand: fetch track data from database API (not Lidarr endpoint)
        icon.classList.add('expanded');
        
        try {
            // Fetch tracks from database via metadata API
            const response = await fetch(`/api/metadata/album-tracks/${albumMbid}`);
            const trackData = await response.json();
            const tracks = trackData.tracks || [];

            if (tracks.length === 0) {
                const noTracksRow = document.createElement('tr');
                noTracksRow.className = 'level-2';
                noTracksRow.setAttribute('data-parent-album', albumMbid);
                noTracksRow.innerHTML = '<td colspan="9" style="color: var(--text-secondary); font-style: italic;">No tracks in database</td>';
                row.insertAdjacentElement('afterend', noTracksRow);
                return;
            }
            
            // Display tracks
            let insertAfter = row;
            for (const track of tracks) {
                const trackRow = document.createElement('tr');
                trackRow.className = 'level-2';
                trackRow.setAttribute('data-parent-album', albumMbid);
                
                const position = `${track.medium_number}-${track.position}`;
                const duration = track.length_ms ? this.formatDuration(track.length_ms / 1000) : '-';
                
                trackRow.innerHTML = `
                    <td>${position}. ${this.escapeHtml(track.title)}</td>
                    <td colspan="7"></td>
                    <td>${duration}</td>
                `;
                
                insertAfter.insertAdjacentElement('afterend', trackRow);
                insertAfter = trackRow;
            }

        } catch (error) {
            console.error('Failed to load tracks:', error);
            this.showError('Failed to load tracks');
        }
    },

    formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    applyFilters() {
        // Get current filter values
        const typeFilter = document.getElementById('albumTypeFilter')?.value || 'Album';
        const statusFilter = document.getElementById('releaseStatusFilter')?.value || 'Official';
        
        this.currentAlbumTypeFilter = typeFilter;
        this.currentReleaseStatusFilter = statusFilter;
        this.hideEmptyArtists = (document.getElementById('emptyArtistFilter')?.value || 'hide') === 'hide';
        
        // Close any expanded rows since filters changed
        const expandedIcons = document.querySelectorAll('.expand-icon.expanded');
        expandedIcons.forEach(icon => {
            const row = icon.closest('tr');
            const artistId = row.getAttribute('data-artist-id');
            const albumId = row.getAttribute('data-album-id');
            
            if (artistId) {
                // Collapse artist
                icon.classList.remove('expanded');
                const childRows = document.querySelectorAll(`tr[data-parent-artist="${artistId}"]`);
                childRows.forEach(r => r.remove());
            } else if (albumId) {
                // Collapse album
                icon.classList.remove('expanded');
                const trackRows = document.querySelectorAll(`tr[data-parent-album="${albumId}"]`);
                trackRows.forEach(r => r.remove());
            }
        });

        // Rebuild table to apply hide-empty filter
        this.rebuildMetadataTable();
    },

    rebuildMetadataTable() {
        const tbody = document.getElementById('metadataTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';
        
        for (const artist of this.metadataArtists) {
            if (this.hideEmptyArtists && parseInt(artist.album_count) === 0) continue;
            const lastUpdated = artist.last_updated_at ? new Date(artist.last_updated_at).toLocaleDateString() + ' ' + new Date(artist.last_updated_at).toLocaleTimeString() : 'Never';
            
            const row = document.createElement('tr');
            row.className = 'level-0 artist-row';
            row.setAttribute('data-artist-id', artist.mbid);
            row.setAttribute('data-name', artist.name.toLowerCase());
            row.innerHTML = `
                <td>
                    <span class="expand-icon" onclick="ui.toggleArtistExpand('${artist.mbid}')">▶</span>
                    ${this.escapeHtml(artist.name)}${this.catalogBadge(this.catalogStateOf(artist))}
                </td>
                <td><a href="https://musicbrainz.org/artist/${artist.mbid}" target="_blank" class="mbid-link" onclick="event.stopPropagation()" title="View on MusicBrainz">${artist.mbid.substring(0, 8)}...</a></td>
                <td>${artist.type || '-'}</td>
                <td>${artist.country || '-'}</td>
                <td>${artist.album_count}</td>
                <td>${artist.release_count}</td>
                <td>${artist.track_count}</td>
                <td>${lastUpdated}</td>
                <td>
                    <button class="btn-refresh" onclick="ui.refreshArtistMetadata('${artist.mbid}')">Fetch</button>
                            <button class="btn-refresh danger" onclick="ui.clearMetadata('artist', '${artist.mbid}', this)">Clear</button>
                            <button class="btn-refresh danger" onclick="ui.blockMetadata('artist', '${artist.mbid}', this)">Block</button>
                    ${this.lidarrEnabled ? `<button class="btn-refresh" style="margin-left:0.25rem;" onclick="ui.refreshInLidarr('${artist.mbid}', this)">Refresh in Lidarr</button>` : ''}
                </td>
            `;
            tbody.appendChild(row);
        }
    },

    filterMetadataTree() {
        const searchInput = document.getElementById('metadataSearchInput');
        const filter = searchInput.value.toLowerCase();
        const rows = document.querySelectorAll('.artist-row');

        rows.forEach(row => {
            const name = row.getAttribute('data-name');
            if (name.includes(filter)) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
                // Also hide child rows
                const artistId = row.getAttribute('data-artist-id');
                const childRows = document.querySelectorAll(`tr[data-parent-artist="${artistId}"]`);
                childRows.forEach(child => child.style.display = 'none');
            }
        });
    },

    sortMetadataTree(column) {
        const tbody = document.getElementById('metadataTableBody');
        if (!this.metadataArtists) return;

        // Toggle sort direction
        if (this.metadataSort.column === column) {
            this.metadataSort.direction = this.metadataSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            this.metadataSort.column = column;
            this.metadataSort.direction = 'asc';
        }

        // Sort artists
        const sorted = [...this.metadataArtists].sort((a, b) => {
            let aVal = a[column];
            let bVal = b[column];

            // Handle nulls
            if (aVal === null || aVal === undefined) aVal = '';
            if (bVal === null || bVal === undefined) bVal = '';

            // String comparison for text columns
            if (typeof aVal === 'string') {
                aVal = aVal.toLowerCase();
                bVal = bVal.toLowerCase();
            }

            if (aVal < bVal) return this.metadataSort.direction === 'asc' ? -1 : 1;
            if (aVal > bVal) return this.metadataSort.direction === 'asc' ? 1 : -1;
            return 0;
        });

        // Update table headers
        document.querySelectorAll('.metadata-table th').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
        });
        const headerMap = {
            'name': 0,
            'type': 2,
            'country': 3,
            'album_count': 4,
            'release_count': 5,
            'track_count': 6,
            'last_updated_at': 7
        };
        const thIndex = headerMap[column];
        if (thIndex !== undefined) {
            const th = document.querySelectorAll('.metadata-table th')[thIndex];
            th.classList.add(this.metadataSort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }

        // Rebuild tbody
        this.metadataArtists = sorted;
        tbody.innerHTML = '';
        
        for (const artist of sorted) {
            const lastUpdated = artist.last_updated_at ? new Date(artist.last_updated_at).toLocaleDateString() + ' ' + new Date(artist.last_updated_at).toLocaleTimeString() : 'Never';
            
            const row = document.createElement('tr');
            row.className = 'level-0 artist-row';
            row.setAttribute('data-artist-id', artist.mbid);
            row.setAttribute('data-name', artist.name.toLowerCase());
            
            row.innerHTML = `
                <td>
                    <span class="expand-icon" onclick="ui.toggleArtistExpand('${artist.mbid}')">▶</span>
                    ${this.escapeHtml(artist.name)}${this.catalogBadge(this.catalogStateOf(artist))}
                </td>
                <td><a href="https://musicbrainz.org/artist/${artist.mbid}" target="_blank" class="mbid-link" onclick="event.stopPropagation()" title="View on MusicBrainz">${artist.mbid.substring(0, 8)}...</a></td>
                <td>${artist.type || '-'}</td>
                <td>${artist.country || '-'}</td>
                <td>${artist.album_count}</td>
                <td>${artist.release_count}</td>
                <td>${artist.track_count}</td>
                <td>${lastUpdated}</td>
                <td>
                    <button class="btn-refresh" onclick="ui.refreshArtistMetadata('${artist.mbid}')">Fetch</button>
                            <button class="btn-refresh danger" onclick="ui.clearMetadata('artist', '${artist.mbid}', this)">Clear</button>
                            <button class="btn-refresh danger" onclick="ui.blockMetadata('artist', '${artist.mbid}', this)">Block</button>
                    ${this.lidarrEnabled ? `<button class="btn-refresh" style="margin-left:0.25rem;" onclick="ui.refreshInLidarr('${artist.mbid}', this)">Refresh in Lidarr</button>` : ''}
                </td>
            `;
            
            tbody.appendChild(row);
        }
    },

    async refreshArtistMetadata(mbid) {
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Fetching...';

        // Reset button after 3 seconds regardless of outcome
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = 'Fetch';
        }, 3000);

        try {
            // Use UI-specific endpoint that fetches EVERYTHING (all albums + all tracks)
            const response = await fetch(`/api/ui/fetch-artist/${mbid}`, { method: 'POST' });
            if (!response.ok) throw new Error('Fetch failed');
            
            this.showSuccess('Artist fetch queued');
        } catch (error) {
            console.error('Failed to fetch artist:', error);
            this.showError('Failed to fetch artist metadata');
        }
    },

    async refreshAlbumMetadata(albumMbid, artistMbid) {
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Fetching...';

        // Reset button after 3 seconds regardless of outcome
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = 'Fetch';
        }, 3000);

        try {
            const response = await fetch(`/api/ui/fetch-album/${albumMbid}`, { method: 'POST' });
            if (!response.ok) throw new Error('Fetch failed');
            
            this.showSuccess('Album fetch queued');
        } catch (error) {
            console.error('Failed to fetch album:', error);
            this.showError('Failed to fetch album tracks');
        }
    },

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            this.showSuccess('MBID copied to clipboard');
        }).catch(err => {
            console.error('Failed to copy:', err);
            this.showError('Failed to copy MBID');
        });
    },

    async saveMetadataSources() {
        try {
            // Flat dot-path keys so saving one provider's fields never replaces the whole
            // providers section (which would drop the MusicBrainz sources list).
            const updates = {};

            document.querySelectorAll('#metadataSourcesForm input, #metadataSourcesForm select').forEach(input => {
                const path = input.id.split('.');
                if (path[0] !== 'providers') return;
                const key = `providers.${path[1]}.${path[2]}`;

                if (input.disabled) {
                    return;   // set by the environment: only compose changes it
                } else if (path[2] === 'apiKey') {
                    // A masked key is unchanged; an emptied field is sent empty, which deletes the key
                    if (!input.value.endsWith('***')) updates[key] = input.value.trim();
                } else if (input.type === 'checkbox') {
                    updates[key] = input.checked;
                } else if (input.type === 'number') {
                    updates[key] = parseFloat(input.value);
                } else if (input.value && !input.value.endsWith('***')) {
                    // Don't save masked values (contain ***)
                    updates[key] = input.value;
                }
            });

            await api.updateConfig(updates);
            this.showSuccess('Metadata Changes Require Server Restart');
        } catch (error) {
            console.error('Failed to save metadata sources:', error);
            this.showError('Failed to save metadata sources');
        }
    },

    async restartServer() {
        if (!confirm('Restart server? Server will be unavailable for ~10 seconds.')) {
            return;
        }

        try {
            const restartBtn = event.target;
            restartBtn.disabled = true;
            restartBtn.textContent = 'Restarting...';

            await api.restartServer();
            this.showSuccess('Server restarting...');

            // Disable button for 30 seconds
            setTimeout(() => {
                restartBtn.disabled = false;
                restartBtn.textContent = 'Restart Server';
            }, 30000);
        } catch (error) {
            console.error('Failed to restart server:', error);
            this.showError('Failed to restart server');
            event.target.disabled = false;
            event.target.textContent = 'Restart Server';
        }
    },



    async testSearch() {
        const query = document.getElementById('testQuery').value;
        const limit = parseInt(document.getElementById('testLimit').value);
        const resultsDiv = document.getElementById('testResults');

        if (!query) {
            resultsDiv.innerHTML = '<p class="alert alert-danger">Please enter a search term</p>';
            return;
        }

        resultsDiv.innerHTML = '<p>Searching MusicBrainz...</p>';

        try {
            const searchResults = await api.searchArtist(query, limit);

            if (searchResults.length === 0) {
                resultsDiv.innerHTML = '<p class="alert alert-info">No results found for "' + this.escapeHtml(query) + '"</p>';
                return;
            }

            let html = '<table class="metadata-table" style="margin-top: 1rem;">';
            html += '<thead><tr><th>Artist</th><th>Type</th><th>Country</th><th>Overview</th><th>Action</th></tr></thead>';
            html += '<tbody>';

            for (const result of searchResults) {
                const overview = result.overview || '';
                const overviewDisplay = overview ? this.escapeHtml(overview.substring(0, 300) + (overview.length > 300 ? '...' : '')) : '<em style="color: var(--text-secondary)">No overview available</em>';
                const type = result.type || '-';
                const country = result.country || '-';
                html += `
                    <tr>
                        <td><strong>${this.escapeHtml(result.artistname)}</strong>${result.disambiguation ? '<br><small style="color:var(--text-secondary)">' + this.escapeHtml(result.disambiguation) + '</small>' : ''}</td>
                        <td>${this.escapeHtml(type)}</td>
                        <td>${this.escapeHtml(country)}</td>
                        <td style="max-width: 400px; font-size: 0.85rem;">${overviewDisplay}</td>
                        <td><button class="btn btn-primary" onclick="ui.fetchArtistFromSearch('${result.id}', this)">Fetch</button></td>
                    </tr>
                `;
            }

            html += '</tbody></table>';
            resultsDiv.innerHTML = html;
        } catch (error) {
            console.error('Search failed:', error);
            resultsDiv.innerHTML = `<p class="alert alert-danger">Search failed: ${error.message}</p>`;
        }
    },

    async fetchArtistFromSearch(mbid, btn) {
        btn.disabled = true;
        btn.textContent = 'Queued';
        try {
            const response = await fetch(`/api/ui/fetch-artist/${mbid}`, { method: 'POST' });
            if (!response.ok) throw new Error('Fetch failed');
            this.showSuccess('Artist fetch queued — check logs for progress');
        } catch (error) {
            console.error('Failed to queue fetch:', error);
            btn.disabled = false;
            btn.textContent = 'Fetch';
            this.showError('Failed to queue artist fetch');
        }
    },

    // ─── Settings Tab ────────────────────────────────────────────────────────

    async loadSettingsTab() {
        try {
            const config = await api.getConfig();
            const li = config.lidarrIntegration || {};
            // No switch: it is on when it has a URL and a key; a value set in the environment wins and can only be changed there
            const urlEl = document.getElementById('settings.lidarr.url');
            const keyEl = document.getElementById('settings.lidarr.apiKey');
            urlEl.value = li.url || '';
            keyEl.value = li.apiKey || '';
            urlEl.disabled = !!li.urlFromEnv;
            keyEl.disabled = !!li.apiKeyFromEnv;
            urlEl.title = li.urlFromEnv ? 'Set by LIDARR_URL in the environment (compose)' : '';
            keyEl.title = li.apiKeyFromEnv ? 'Set by LIDARR_API_KEY in the environment (compose)' : '';
            const stateEl = document.getElementById('lidarrState');
            if (stateEl) {
                const fromEnv = li.urlFromEnv || li.apiKeyFromEnv;
                stateEl.textContent = (li.enabled
                    ? 'On. Remove the URL or the API key and restart the server to turn it off.'
                    : 'Off. Enter a URL and an API key and restart the server to turn it on.')
                    + (fromEnv ? ' Fields set in the environment can only be changed in the compose file.' : '');
            }
            const levelEl = document.getElementById('settings.logLevel');
            if (levelEl) levelEl.value = config.server?.logLevel || 'info';
            const ttlEl = document.getElementById('settings.metadata.ttlDays');
            if (ttlEl) ttlEl.value = (config.metadata && config.metadata.ttlDays) || 30;
            this.loadBlocklist();
            this.loadWs2Keys();
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    },

    async saveRetention() {
        try {
            const days = parseInt(document.getElementById('settings.metadata.ttlDays').value, 10);
            if (!Number.isInteger(days) || days < 1) {
                this.showError('TTL must be a whole number of days ≥ 1');
                return;
            }
            // Dot-path key so we set metadata.ttlDays without clobbering the rest of metadata.
            await api.updateConfig({ 'metadata.ttlDays': days });
            this.showSuccess(`Metadata TTL set to ${days} days`);
        } catch (e) {
            this.showError('Failed to save retention setting');
        }
    },

    // ─── Clearing and blocking metadata ───────────────────────────────────────────────

    // The name on the row a button sits in (artist and album rows keep it in their first cell)
    _rowName(btn) {
        const cell = btn && btn.closest('tr') && btn.closest('tr').querySelector('td');
        return cell ? cell.textContent.replace(/[▶▼]/g, '').replace(/\s+/g, ' ').trim() : '';
    },

    _describeRemoval(s) {
        const parts = [];
        if (s.release_groups) parts.push(`${s.release_groups} album${s.release_groups === 1 ? '' : 's'}`);
        if (s.releases) parts.push(`${s.releases} release${s.releases === 1 ? '' : 's'}`);
        if (s.tracks) parts.push(`${s.tracks} track${s.tracks === 1 ? '' : 's'}`);
        if (s.images) parts.push(`${s.images} image${s.images === 1 ? '' : 's'}`);
        return parts.length ? parts.join(', ') : 'nothing else';
    },

    async _removeRequest(url, options) {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    },

    // Disables the button and shows what it is doing until `work` settles, then restores it
    async _busy(btn, label, work) {
        if (!btn) return work();
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span>${label}`;
        try { return await work(); } finally { btn.disabled = false; btn.innerHTML = original; }
    },

    async clearMetadata(type, mbid, btn) {
        const name = this._rowName(btn) || mbid;
        try {
            const preview = await this._busy(btn, 'Counting…', () => this._removeRequest(`/api/metadata/clear-preview/${type}/${mbid}`));
            const kind = type === 'artist' ? 'artist' : 'album';
            let msg = `Clear the stored metadata of ${kind} "${name}"?\n\nThis removes ${this._describeRemoval(preview)}` + (type === 'artist' ? ' (images you uploaded included)' : '') + '.';
            if (type === 'artist' && preview.artists_kept) msg += `\n\nThe artist's name stays, because an album that remains credits it; its catalog is removed.`;
            if (preview.lidarr === 'in') msg += `\n\nIt IS in Lidarr's library: its albums come back at the next Lidarr request, and Lidarr may briefly see none.`;
            msg += '\n\nIt is fetched again the next time it is requested. To stop that, use Block.';
            if (!confirm(msg)) return;
            const r = await this._busy(btn, 'Clearing…', () => this._removeRequest(`/api/metadata/${type === 'artist' ? 'artist' : 'album'}/${mbid}`, { method: 'DELETE' }));
            this.showSuccess(`Cleared ${name}: ${this._describeRemoval(r)}`);
            this.loadMetadataTree();
        } catch (e) {
            this.showError(`Clear failed: ${e.message}`);
        }
    },

    async blockMetadata(type, mbid, btn) {
        const name = this._rowName(btn) || mbid;
        try {
            const preview = await this._busy(btn, 'Counting…', () => this._removeRequest(`/api/metadata/clear-preview/${type}/${mbid}`));
            if (preview.lidarr === 'in') { this.showError(`"${name}" is in Lidarr's library: remove it from Lidarr first`); return; }
            if (preview.lidarr === 'unknown') { this.showError('Lidarr cannot confirm whether this is in its library right now: nothing blocked'); return; }
            const msg = `Block ${type === 'artist' ? 'artist' : 'album'} "${name}"?\n\nnuLMD will never fetch or store it again, and its stored metadata is removed now (${this._describeRemoval(preview)}). Lidarr is sent ` + (type === 'artist' ? 'no albums for it' : 'a 404 for it') + '. You can unblock it in Settings.';
            if (!confirm(msg)) return;
            const r = await this._busy(btn, 'Blocking…', () => this._removeRequest('/api/blocklist', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, mbid, name })
            }));
            this.showSuccess(`Blocked ${name}` + (r.cleared ? `: ${this._describeRemoval(r.cleared)} removed` : ''));
            this.loadMetadataTree();
        } catch (e) {
            this.showError(`Block failed: ${e.message}`);
        }
    },

    async pruneMetadataNotInLidarr(btn) {
        try {
            const post = dryRun => this._removeRequest('/api/metadata/prune-not-in-lidarr', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun })
            });
            const preview = await this._busy(btn, 'Counting…', () => post(true));
            if (!preview.artists) { this.showSuccess('Nothing to trim: every stored artist is in Lidarr'); return; }
            let msg = `Delete the stored metadata of ${preview.artists - preview.artists_kept} artist(s) that are not in Lidarr?\n\nThis removes ${this._describeRemoval(preview)}.`;
            if (preview.artists_kept) msg += `\n${preview.artists_kept} more artist(s) keep their name only (an album in Lidarr credits them) and lose their catalog.`;
            msg += `\n\nArtists and albums in Lidarr are kept. Anything requested again later (by Lidarr or a /ws/2 client) is fetched again.`;
            if (!confirm(msg)) return;
            this.showSuccess('Trimming… this can take a few minutes on a large library');
            const r = await this._busy(btn, 'Trimming…', () => post(false));
            this.showSuccess(`Removed ${this._describeRemoval(r)} of ${r.artists} artists (${(r.bytes / (1024 * 1024)).toFixed(1)} MB of images)`);
        } catch (e) {
            this.showError(`Trim failed: ${e.message}`);
        }
    },

    async loadBlocklist() {
        const box = document.getElementById('blocklistList');
        if (!box) return;
        try {
            const data = await (await fetch('/api/blocklist')).json();
            const rows = [...data.builtin, ...data.entries];
            box.innerHTML = rows.map(e => `
                <div class="blocklist-row">
                    <span class="blocklist-kind">${this.escapeHtml(e.entity_type.replace('_', ' '))}</span>
                    <span class="blocklist-name">${this.escapeHtml(e.name || '')}${e.builtin ? ' <em>(built in)</em>' : ''}</span>
                    <span class="blocklist-mbid">${this.escapeHtml(e.mbid)}</span>
                    ${e.builtin ? '' : `<button class="btn btn-secondary btn-sm" onclick="ui.unblock('${e.entity_type}', '${e.mbid}')">Unblock</button>`}
                </div>`).join('') || 'Nothing blocked';
        } catch (e) {
            box.textContent = 'Failed to load the blocklist';
        }
    },

    async addBlock(btn) {
        const type = document.getElementById('blockType').value;
        const mbid = document.getElementById('blockMbid').value.trim().toLowerCase();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mbid)) { this.showError('Enter a valid MusicBrainz ID'); return; }
        if (!confirm(`Block this ${type.replace('_', ' ')} and remove what nuLMD holds for it?\n\n${mbid}`)) return;
        try {
            const r = await this._busy(btn, 'Blocking…', () => this._removeRequest('/api/blocklist', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, mbid })
            }));
            this.showSuccess('Blocked' + (r.cleared ? `: ${this._describeRemoval(r.cleared)} removed` : ''));
            document.getElementById('blockMbid').value = '';
            this.loadBlocklist();
        } catch (e) {
            this.showError(`Block failed: ${e.message}`);
        }
    },

    async unblock(type, mbid) {
        try {
            await this._removeRequest(`/api/blocklist/${type}/${mbid}`, { method: 'DELETE' });
            this.showSuccess('Unblocked: it is fetched again only when it is next requested');
            this.loadBlocklist();
        } catch (e) {
            this.showError(`Unblock failed: ${e.message}`);
        }
    },

    async pruneImagesNotInLidarr(btn) {
        if (!confirm('Delete locally-cached images for artists/albums no longer in Lidarr?\n\nImages for artists still in Lidarr are kept (including your uploads). If an artist has left Lidarr, all its images are removed. Trimmed images will re-download if Lidarr requests them again.')) return;
        try {
            const data = await this._busy(btn, 'Trimming…', async () => {
                const response = await fetch('/api/images/prune-not-in-lidarr', { method: 'POST' });
                return response.json();
            });
            if (!data.success) {
                this.showError(data.error || 'Trim failed');
                return;
            }
            const mb = (data.bytesFreed / (1024 * 1024)).toFixed(1);
            let msg = `Removed ${data.deleted} images (${data.artists} artist, ${data.albums} album) — freed ${mb} MB`;
            if (!data.albumTrimEnabled) msg += ' (Lidarr album list unavailable — album art left untouched)';
            this.showSuccess(msg);
        } catch (e) {
            this.showError('Failed to trim images');
        }
    },

    // What the Lidarr fields change, as flat dot-path keys so a save sends only what the user can change: a field set in the
    // environment is skipped, a masked key (unchanged) is skipped, and an emptied field is sent empty, which deletes it
    _lidarrUpdates() {
        const urlEl = document.getElementById('settings.lidarr.url');
        const keyEl = document.getElementById('settings.lidarr.apiKey');
        const updates = {};
        if (!urlEl.disabled) updates['lidarrIntegration.url'] = urlEl.value.trim();
        if (!keyEl.disabled && !keyEl.value.endsWith('***')) updates['lidarrIntegration.apiKey'] = keyEl.value.trim();
        return updates;
    },

    async saveSettings() {
        try {
            const updates = this._lidarrUpdates();
            if (Object.keys(updates).length) await api.updateConfig(updates);
            this.showSuccess('Settings saved — restart server to apply');
        } catch (e) {
            this.showError('Failed to save settings');
        }
    },

    // ─── Lidarr Integration ─────────────────────────────────────────────────

    async saveLogLevel() {
        const level = document.getElementById('settings.logLevel').value;
        try {
            const response = await fetch('/api/log-level', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ level })
            });
            const result = await response.json();
            if (result.success) {
                this.showSuccess(`Log level set to: ${level}`);
            } else {
                this.showError(result.error || 'Failed to set log level');
            }
        } catch (e) {
            this.showError('Failed to set log level');
        }
    },

    async testLidarrConnection() {
        const resultEl = document.getElementById('lidarrTestResult');
        resultEl.textContent = 'Testing...';
        resultEl.style.color = 'var(--text-secondary)';

        try {
            const url = document.getElementById('settings.lidarr.url')?.value || '';
            const apiKey = document.getElementById('settings.lidarr.apiKey')?.value || '';

            if (!url || !apiKey) {
                resultEl.textContent = '✘ URL and API key required';
                resultEl.style.color = '#f05050';
                return;
            }

            // Save config first so the server has the latest values
            const updates = this._lidarrUpdates();
            if (Object.keys(updates).length) await api.updateConfig(updates);

            const response = await fetch('/api/lidarr/test', { method: 'POST' });
            const result = await response.json();

            if (result.success) {
                resultEl.textContent = `✔ Connected — Lidarr v${result.version}`;
                resultEl.style.color = '#00A65B';
            } else {
                resultEl.textContent = `✘ ${result.error}`;
                resultEl.style.color = '#f05050';
            }
        } catch (e) {
            resultEl.textContent = `✘ ${e.message}`;
            resultEl.style.color = '#f05050';
        }
    },

    async refreshInLidarr(mbid, btn) {
        btn.disabled = true;
        btn.textContent = 'Refreshing...';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Refresh in Lidarr'; }, 5000);

        try {
            const response = await fetch(`/api/lidarr/refresh/${mbid}`, { method: 'POST' });
            const result = await response.json();

            if (result.success) {
                this.showSuccess('Lidarr refresh triggered');
            } else if (result.skipped) {
                this.showError('Artist not found in Lidarr');
            } else {
                this.showError(`Lidarr refresh failed: ${result.error}`);
            }
        } catch (e) {
            this.showError('Failed to contact Lidarr');
        }
    },

    // ─── Images Tab ──────────────────────────────────────────────────────────

    async loadImagesTab() {
        const listEl = document.getElementById('imageArtistList');
        listEl.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">Loading...</p>';

        try {
            const response = await fetch('/api/metadata/artists');
            this.imageArtists = await response.json();
            this.imageArtists.sort((a, b) => a.name.localeCompare(b.name));
            this.filterImageArtistList();
        } catch (e) {
            listEl.innerHTML = '<p style="color: var(--text-secondary);">Failed to load artists</p>';
        }
    },

    _renderImageArtistList(artists) {
        const listEl = document.getElementById('imageArtistList');
        if (artists.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">No artists found</p>';
            return;
        }
        listEl.innerHTML = artists.map(a => `
            <div class="log-file-entry ${this.selectedImageArtist === a.mbid ? 'active' : ''}" 
                 onclick="ui.selectImageArtist('${a.mbid}', '${this.escapeHtml(a.name).replace(/'/g, "\\'")}')"
                 data-name="${a.name.toLowerCase()}">
                <div class="log-file-name">${this.escapeHtml(a.name)}</div>
                <div class="log-file-meta">${a.type || 'Unknown'}</div>
            </div>
        `).join('');
    },

    filterImageArtistList() {
        const q = document.getElementById('imageArtistSearch').value.toLowerCase();
        let filtered = (this.imageArtists || []);

        // Apply image filter
        const mode = document.getElementById('imageFilterMode')?.value || 'has';
        if (mode === 'has') {
            filtered = filtered.filter(a => (parseInt(a.artist_image_count) || 0) + (parseInt(a.album_image_count) || 0) > 0);
        } else if (mode === 'no') {
            filtered = filtered.filter(a => (parseInt(a.artist_image_count) || 0) + (parseInt(a.album_image_count) || 0) === 0);
        }

        // Apply text search
        if (q) {
            filtered = filtered.filter(a => a.name.toLowerCase().includes(q));
        }
        this._renderImageArtistList(filtered);
    },

    applyImageFilter() {
        this.filterImageArtistList();
    },

    async selectImageArtist(mbid, name) {
        this.selectedImageArtist = mbid;
        // Re-render list to update active state
        this.filterImageArtistList();

        const panel = document.getElementById('imageDetailPanel');
        panel.innerHTML = '<div class="card"><p style="color: var(--text-secondary);">Loading...</p></div>';

        try {
            const [artistImages, albums] = await Promise.all([
                fetch(`/api/images/artist/${mbid}`).then(r => r.json()),
                fetch(`/api/images/artist-albums/${mbid}`).then(r => r.json())
            ]);

            let html = '';

            // Artist images card
            html += '<div class="card" style="margin-bottom: 1.5rem;">';
            html += `<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">`;
            html += `<h2>${this.escapeHtml(name)} — Artist Images</h2>`;
            html += `<div style="display: flex; gap: 0.5rem;">`;
            html += `<button class="btn btn-secondary" onclick="ui.refreshArtistImages('${mbid}')">Fetch Images</button>`;
            html += `<button class="btn btn-secondary" onclick="ui.showUploadForm('artist', '${mbid}', null)">Upload Image</button>`;
            html += `</div>`;
            html += '</div>';
            html += this._renderImageGrid(artistImages, 'artist');
            html += '</div>';

            // Albums
            if (albums.length > 0) {
                html += '<div class="card">';
                html += `<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">`;
                html += `<h2 style="margin: 0;">Album Images</h2>`;
                html += `<button class="btn btn-secondary" onclick="ui.fetchAllAlbumImages('${mbid}')">Fetch All Album Images</button>`;
                html += `</div>`;
                html += '<div id="imageAlbumList">';
                for (const album of albums) {
                    const year = album.first_release_date ? album.first_release_date.substring(0, 4) : '?';
                    html += `
                        <div style="border-bottom: 1px solid var(--border); padding: 1rem 0;">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
                                <div>
                                    <strong>${this.escapeHtml(album.title)}</strong>
                                    <span style="color: var(--text-secondary); font-size: 0.85rem; margin-left: 0.5rem;">${year} &middot; ${album.primary_type || ''}</span>
                                </div>
                                <div style="display: flex; gap: 0.5rem;">
                                <button class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.3rem 0.75rem;" onclick="ui.refreshAlbumImages('${album.mbid}')">Fetch Image</button>
                                <button class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.3rem 0.75rem;" onclick="ui.showUploadForm('album', '${album.mbid}', '${album.mbid}')">Upload Image</button>
                                </div>
                            </div>
                            <div id="album-images-${album.mbid}">
                                <p style="color: var(--text-secondary); font-size: 0.85rem;">Loading...</p>
                            </div>
                        </div>
                    `;
                }
                html += '</div></div>';
            }

            panel.innerHTML = html;

            // Load album images async
            for (const album of albums) {
                fetch(`/api/images/album/${album.mbid}`)
                    .then(r => r.json())
                    .then(images => {
                        const el = document.getElementById(`album-images-${album.mbid}`);
                        if (el) el.innerHTML = this._renderImageGrid(images, 'album');
                    })
                    .catch(() => {});
            }

        } catch (e) {
            panel.innerHTML = '<div class="card"><p style="color: var(--text-secondary);">Failed to load images</p></div>';
        }
    },

    _renderImageGrid(images, entityKind) {
        if (images.length === 0) {
            return '<p style="color: var(--text-secondary); font-size: 0.875rem;">No images cached</p>';
        }
        return '<div style="display: flex; flex-wrap: wrap; gap: 1rem;">' +
            images.map(img => {
                const srcPath = img.local_path
                    ? `/api/images/${img.entity_type}/${img.entity_mbid}/${img.local_path.split('/').pop()}`
                    : img.url;
                const sourceBadgeColor = img.user_uploaded ? '#00A65B' : 'var(--text-secondary)';
                const sourceLabel = img.user_uploaded ? 'manual' : img.provider;
                return `
                    <div style="width: 160px;">
                        <div style="width: 160px; height: 160px; background: var(--bg-tertiary); border-radius: 0.375rem; overflow: hidden; display: flex; align-items: center; justify-content: center; margin-bottom: 0.5rem;">
                            ${img.cached
                                ? `<img src="${srcPath}" style="max-width: 100%; max-height: 100%; object-fit: contain;" onerror="this.parentElement.innerHTML='<span style=color:var(--text-secondary);font-size:0.75rem>Failed to load</span>'">`
                                : `<span style="color: var(--text-secondary); font-size: 0.75rem; text-align: center; padding: 0.5rem;">${img.cache_failed ? 'Unavailable' : 'Not cached'}</span>`
                            }
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.25rem;">
                            <div>
                                <div style="font-size: 0.8rem; font-weight: 600;">${img.cover_type}</div>
                                <div style="font-size: 0.75rem; color: ${sourceBadgeColor};">${sourceLabel}</div>
                            </div>
                            <button class="btn-refresh" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; flex-shrink: 0;" onclick="ui.deleteImage(${img.id}, '${img.entity_type}', '${img.entity_mbid}')">Delete</button>
                        </div>
                    </div>
                `;
            }).join('') + '</div>';
    },

    showUploadForm(entityKind, mbid, albumMbid) {
        const allowedTypes = entityKind === 'artist'
            ? ['Poster', 'Banner', 'Fanart', 'Logo', 'Clearart', 'Thumb']
            : ['Cover', 'Disc', 'Clearart'];

        const existingModal = document.getElementById('imageUploadModal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'imageUploadModal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:0.5rem;padding:1.5rem;width:400px;">
                <h3 style="margin-bottom:1rem;">Upload ${entityKind === 'artist' ? 'Artist' : 'Album'} Image</h3>
                <div class="form-group">
                    <label>Image Type</label>
                    <select id="uploadImageType" class="form-control">
                        ${allowedTypes.map(t => `<option value="${t}">${t}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Image File (JPEG, PNG, WebP, GIF — max 20MB)</label>
                    <input type="file" id="uploadImageFile" accept="image/jpeg,image/png,image/webp,image/gif" class="form-control">
                </div>
                <div style="display:flex;gap:0.75rem;margin-top:1rem;">
                    <button class="btn btn-primary" onclick="ui.submitImageUpload('${entityKind}', '${mbid}')">Upload</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('imageUploadModal').remove()">Cancel</button>
                </div>
                <p id="uploadStatus" style="margin-top:0.75rem;font-size:0.85rem;"></p>
            </div>
        `;
        document.body.appendChild(modal);
    },

    async submitImageUpload(entityKind, mbid) {
        const typeEl = document.getElementById('uploadImageType');
        const fileEl = document.getElementById('uploadImageFile');
        const statusEl = document.getElementById('uploadStatus');

        if (!fileEl.files[0]) {
            statusEl.textContent = 'Select a file first.';
            return;
        }

        const formData = new FormData();
        formData.append('file', fileEl.files[0]);
        formData.append('type', typeEl.value);

        statusEl.textContent = 'Uploading...';

        try {
            const endpoint = entityKind === 'artist'
                ? `/api/images/artist/${mbid}/upload`
                : `/api/images/album/${mbid}/upload`;

            const response = await fetch(endpoint, { method: 'POST', body: formData });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Upload failed');
            }

            document.getElementById('imageUploadModal').remove();
            this.showSuccess('Image uploaded');

            // Refresh the artist panel
            if (this.selectedImageArtist) {
                const artistEl = document.querySelector(`[data-name] .log-file-name`);
                const name = document.querySelector(`#imageArtistList .active .log-file-name`)?.textContent || '';
                this.selectImageArtist(this.selectedImageArtist, name);
            }
        } catch (e) {
            statusEl.textContent = `Error: ${e.message}`;
        }
    },

    async deleteImage(imageId, entityType, entityMbid) {
        if (!confirm('Delete this image? This cannot be undone.')) return;

        try {
            const response = await fetch(`/api/images/${imageId}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Delete failed');

            this.showSuccess('Image deleted');

            // Refresh panel
            if (this.selectedImageArtist) {
                const name = document.querySelector('#imageArtistList .active .log-file-name')?.textContent || '';
                this.selectImageArtist(this.selectedImageArtist, name);
            }
        } catch (e) {
            this.showError('Failed to delete image');
        }
    },

    // ─── Logs Tab ────────────────────────────────────────────────────────────────

    async loadLogsTab() {
        this._stopLogPolling();
        this.logPaused = false;
        const pauseBtn = document.getElementById('logPauseBtn');
        if (pauseBtn) pauseBtn.textContent = 'Pause';
        await this.loadLogFileList();
        const firstEntry = document.querySelector('.log-file-entry');
        if (firstEntry) firstEntry.click();
    },

    async loadLogFileList() {
        const container = document.getElementById('logFileList');
        try {
            const response = await fetch('/api/logs/files');
            const files = await response.json();

            if (files.length === 0) {
                container.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">No log files yet</p>';
                return;
            }

            let html = '';
            for (const file of files) {
                const sizeKb = Math.round(file.size_bytes / 1024);
                const modified = new Date(file.modified_at).toLocaleDateString();
                const isActive = this.currentLogFile === file.name;
                html += `<div class="log-file-entry ${isActive ? 'active' : ''}" onclick="ui.selectLogFile('${file.name}')">
                    <div class="log-file-name">${this.escapeHtml(file.name)}</div>
                    <div class="log-file-meta">${sizeKb} KB &middot; ${modified}</div>
                </div>`;
            }

            container.innerHTML = html;
        } catch (error) {
            container.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.875rem;">Failed to load log files</p>';
        }
    },

    async selectLogFile(filename) {
        this.currentLogFile = filename;
        this.currentLogLineCount = 0;
        this._stopLogPolling();

        // Update active state in file list
        await this.loadLogFileList();

        const viewer = document.getElementById('logViewer');
        const title = document.getElementById('logViewerTitle');

        if (!filename) {
            title.textContent = 'Select a log file';
            viewer.innerHTML = '<div class="log-empty">Select a log file from the left panel</div>';
            return;
        }

        title.textContent = filename;
        viewer.innerHTML = '<div class="log-loading">Loading...</div>';

        try {
            const response = await fetch(`/api/logs/file?name=${encodeURIComponent(filename)}&tail=${this.logTailLines}`);
            if (!response.ok) throw new Error('Failed to load file');
            const logs = await response.json();

            if (logs.length === 0) {
                viewer.innerHTML = '<div class="log-empty">No log entries</div>';
                this.currentLogLineCount = 0;
            } else {
                viewer.innerHTML = logs.map(log => this.formatLogLine(log)).join('');
                viewer.scrollTop = viewer.scrollHeight;
                this.currentLogLineCount = logs.length;
            }
            this._startLogPolling(filename);
        } catch (error) {
            viewer.innerHTML = `<div class="log-empty">Failed to load ${filename}</div>`;
        }
    },

    _startLogPolling(filename) {
        this._stopLogPolling();
        this.logPollInterval = setInterval(async () => {
            if (this.logPaused) return;
            if (!document.getElementById('logs-tab').classList.contains('active')) return;
            try {
                const response = await fetch(`/api/logs/file?name=${encodeURIComponent(filename)}&tail=${this.logTailLines}`);
                if (!response.ok) return;
                const logs = await response.json();
                if (logs.length <= this.currentLogLineCount) return;
                const newLines = logs.slice(this.currentLogLineCount);
                const viewer = document.getElementById('logViewer');
                if (!viewer) return;
                newLines.forEach(log => {
                    viewer.insertAdjacentHTML('beforeend', this.formatLogLine(log));
                });
                viewer.scrollTop = viewer.scrollHeight;
                this.currentLogLineCount = logs.length;
            } catch (e) {
                // silent — don't disrupt the viewer on a poll failure
            }
        }, 2000);
    },

    _stopLogPolling() {
        if (this.logPollInterval) {
            clearInterval(this.logPollInterval);
            this.logPollInterval = null;
        }
    },

    toggleLogPause() {
        this.logPaused = !this.logPaused;
        const btn = document.getElementById('logPauseBtn');
        if (btn) btn.textContent = this.logPaused ? 'Resume' : 'Pause';
    },

    applyLogTailLines() {
        const input = document.getElementById('logTailLines');
        const val = parseInt(input.value);
        if (isNaN(val) || val < 100 || val > 5000) {
            this.showError('Lines must be between 100 and 5000');
            return;
        }
        this.logTailLines = val;
        if (this.currentLogFile) {
            this.selectLogFile(this.currentLogFile);
        }
    },

    // Where an artist's catalog stands. Checked ones need no mark; the others say why they differ
    catalogStateOf(artist) {
        if (artist.catalog_provisional) return 'provisional';
        if (artist.catalog_verified_at) return 'verified';
        return artist.catalog_complete_at ? 'unverified' : 'incomplete';
    },

    catalogBadge(state) {
        const marks = {
            provisional: ['provisional', 'Taken from an upstream while MusicBrainz was down. Replaced by the checked copy as soon as MusicBrainz answers.'],
            unverified:  ['older', 'Stored before catalogs were checked against MusicBrainz. Renewed when its TTL runs out.'],
            incomplete:  ['incomplete', 'The catalog has not been fetched yet.']
        };
        const mark = marks[state];
        return mark ? ` <span class="catalog-badge catalog-${state}" title="${mark[1]}">${mark[0]}</span>` : '';
    },

    // "retry in 2m" for a job waiting out a pause after a failure
    // Why a catalog job was queued (job metadata `via`), for the job row
    jobOrigin(job) {
        const via = job.via || '';
        if (!via) return '';
        if (via.startsWith('album-credit:')) return 'via an album credit';
        return { 'artist-request': 'via an artist request', 'provisional-sweep': 'via the provisional sweep', manual: 'started by hand' }[via] || '';
    },

    retryNote(job) {
        if (job.status !== 'pending' || !job.run_after) return '';
        const seconds = Math.round((new Date(job.run_after) - Date.now()) / 1000);
        if (seconds <= 0) return '';
        const wait = seconds >= 90 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
        return `retry in ${wait}`;
    },

    async refreshJobsCard() {
        try {
            const response = await fetch('/api/jobs/recent?type=metadata');
            const jobs = await response.json();
            const container = document.getElementById('jobQueueCard');
            if (!container) return;

            if (jobs.length === 0) {
                this.jobsHasActive = false;
                container.innerHTML = '<div class="job-queue-empty">No jobs yet</div>';
                return;
            }

            this.jobsHasActive = jobs.some(j => j.status === 'processing' || j.status === 'pending');

            container.innerHTML = jobs.map(job => {
                const label = JOB_LABELS[job.job_type] || job.job_type;
                const mbidShort = job.entity_mbid.substring(0, 8);
                const displayName = job.entity_name || (mbidShort + '...');
                const isProcessing = job.status === 'processing';
                const isFailed    = job.status === 'failed';
                const isDone      = job.status === 'completed';
                const barClass    = isFailed      ? 'job-bar-failed'
                                  : isDone        ? 'job-bar-done'
                                  : isProcessing  ? 'job-bar-processing'
                                  : 'job-bar-pending';
                const fillPct     = isDone || isFailed ? '100%' : isProcessing ? '60%' : '0%';

                // For image downloads, show cover type and provider instead of album/release/track counts
                let detailHtml = '';
                if (job.job_type === 'image_download') {
                    const parts = [];
                    if (job.cover_type) parts.push(job.cover_type);
                    if (job.image_provider) parts.push(job.image_provider);
                    if (parts.length > 0) {
                        detailHtml = `<div class="job-counts"><span>${parts.join(' · ')}</span></div>`;
                    }
                } else {
                    const albumCount   = parseInt(job.album_count) || 0;
                    const releaseCount = parseInt(job.release_count) || 0;
                    const trackCount   = parseInt(job.track_count) || 0;
                    const hasCounts    = albumCount > 0 || releaseCount > 0 || trackCount > 0;
                    detailHtml = hasCounts ? `
                        <div class="job-counts">
                            ${albumCount   > 0 ? `<span>${albumCount} albums</span>` : ''}
                            ${releaseCount > 0 ? `<span>${releaseCount} releases</span>` : ''}
                            ${trackCount   > 0 ? `<span>${trackCount} tracks</span>` : ''}
                            ${this.jobOrigin(job) ? `<span title="What queued this job">${this.jobOrigin(job)}</span>` : ''}
                        </div>` : '';
                }

                const retry = this.retryNote(job);
                const attemptNote = job.attempts > 1 && !isDone ? `attempt ${job.attempts}/${job.max_attempts}` : '';
                const notes = [retry, attemptNote].filter(Boolean).join(' · ');
                const errorTitle = job.error_message && !isDone ? ` title="${this.escapeHtml(job.error_message)}"` : '';
                const catalogBadge = job.job_type === 'fetch_artist_albums' ? this.catalogBadge(job.catalog_state) : '';

                const artistPrefix = job.artist_name
                    ? `<span class="job-artist-name">${this.escapeHtml(job.artist_name)}</span> — `
                    : '';

                return `
                    <div class="job-row">
                        <div class="job-row-header">
                            <span class="job-time">${new Date(job.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + new Date(job.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                            <span class="job-label">${artistPrefix}${this.escapeHtml(displayName)} <span class="job-type-badge">${label}</span>${catalogBadge}</span>
                            <span class="job-status job-status-${job.status}"${errorTitle}>${notes ? `${notes} · ` : ''}${job.status}</span>
                        </div>
                        <div class="job-bar-track">
                            <div class="job-bar ${barClass} ${isProcessing ? 'job-bar-animated' : ''}" style="width: ${fillPct}"></div>
                        </div>
                        ${detailHtml}
                    </div>`;
            }).join('');
        } catch (error) {
            console.error('Failed to refresh job queue:', error);
        }
    },

    async refreshDownloadJobsCard() {
        try {
            const response = await fetch('/api/jobs/recent?type=downloads');
            const jobs = await response.json();
            const container = document.getElementById('downloadJobsCard');
            if (!container) return;

            if (jobs.length === 0) {
                container.innerHTML = '<div class="job-queue-empty">No downloads yet</div>';
                return;
            }

            container.innerHTML = jobs.map(job => {
                const isProcessing = job.status === 'processing';
                const isFailed    = job.status === 'failed';
                const isDone      = job.status === 'completed';
                const barClass    = isFailed     ? 'job-bar-failed'
                                  : isDone       ? 'job-bar-done'
                                  : isProcessing ? 'job-bar-processing'
                                  : 'job-bar-pending';
                const fillPct = isDone || isFailed ? '100%' : isProcessing ? '60%' : '0%';
                const displayName = job.entity_name || job.entity_mbid.substring(0, 8) + '...';
                const artistPrefix = job.artist_name
                    ? `<span class="job-artist-name">${this.escapeHtml(job.artist_name)}</span> — `
                    : '';
                const PROVIDER_LABELS = {
                    coverartarchive: 'CoverArtArchive',
                    fanart:          'Fanart.tv',
                    deezer:          'Deezer',
                    theaudiodb:      'TheAudioDB',
                    manual:          'Manual'
                };
                const parts = [];
                if (job.cover_type) parts.push(job.cover_type);
                if (job.image_provider) parts.push(PROVIDER_LABELS[job.image_provider] || job.image_provider);
                const detailHtml = parts.length > 0
                    ? `<div class="job-counts"><span>${parts.join(' · ')}</span></div>`
                    : '';

                return `
                    <div class="job-row">
                        <div class="job-row-header">
                            <span class="job-time">${new Date(job.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + new Date(job.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                            <span class="job-label">${artistPrefix}${this.escapeHtml(displayName)} <span class="job-type-badge">Image Download</span></span>
                            <span class="job-status job-status-${job.status}">${job.status}</span>
                        </div>
                        <div class="job-bar-track">
                            <div class="job-bar ${barClass} ${isProcessing ? 'job-bar-animated' : ''}" style="width: ${fillPct}"></div>
                        </div>
                        ${detailHtml}
                    </div>`;
            }).join('');
        } catch (error) {
            console.error('Failed to refresh download jobs:', error);
        }
    },

    // Who made an inbound request, as a small tag: the name, and the address it came from
    describeClient(e) {
        if (!e.clientName && !e.clientIp) return '<span class="conn-peer conn-lidarr">Lidarr</span>';
        const name = this.escapeHtml(e.clientName || 'unknown');
        const ip = e.clientIp ? this.escapeHtml(e.clientIp) : '';
        const cls = /^lidarr$/i.test(e.clientName || '') ? 'conn-lidarr' : 'conn-client';
        return `<span class="conn-peer ${cls}" title="${ip}">${name}${ip ? ` <span class="conn-ip">${ip}</span>` : ''}</span>`;
    },

    // Two cards from one feed: Requests (who asked nuLMD, and for what) and Responses (what nuLMD sent back, how it made it,
    // and which sources it called to do so). They list the same requests in the same order.
    async refreshConnectionsCard() {
        try {
            const requests = await fetch('/api/requests/recent?direction=inbound').then(r => r.json());
            const fill = (id, empty, rowFn) => {
                const container = document.getElementById(id);
                if (container) container.innerHTML = requests.length === 0 ? `<div class="conn-empty">${empty}</div>` : requests.map(rowFn).join('');
            };
            fill('connectionsCard', 'No requests yet', e => this.requestRow(e));
            fill('responsesCard', 'No responses yet', e => this.responseRow(e));
        } catch (error) {
            console.error('Failed to refresh connections:', error);
        }
    },

    connTime(e) {
        const at = new Date(e.timestamp);
        return at.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    connStatusClass(e) {
        return e.status === 'error' ? 'conn-status-error'
             : e.status === 'cached' ? 'conn-status-cached'
             : e.status === 'pending' ? 'conn-status-pending'
             : 'conn-status-ok';
    },

    formatDuration(ms) {
        if (ms === null || ms === undefined) return '';
        return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
    },

    // The colour of a source's name: MusicBrainz and LMD servers are named "MusicBrainz(label)" / "LMD(label)"
    sourceClass(label) {
        const name = String(label || '');
        if (/^MusicBrainz/i.test(name)) return 'conn-mb';
        if (/^LMD/i.test(name))         return 'conn-api-lmd';
        if (/^Wikipedia/i.test(name))   return 'conn-wikipedia';
        if (/^CoverArtArchive/i.test(name)) return 'conn-caa';
        if (/^Fanart/i.test(name))      return 'conn-fanart';
        if (/^Deezer/i.test(name))      return 'conn-deezer';
        return 'conn-client';
    },

    // One image file handed to Lidarr (inside an Image Fetch request)
    callRow(call) {
        const times = call.count > 1 ? ` <span class="conn-ip">&times;${call.count}</span>` : '';
        const result = [call.outcome, this.formatDuration(call.durationMs)].filter(Boolean).join(' · ');
        return `
            <div class="conn-call">
                <span class="conn-peer ${this.sourceClass(call.label)}">${this.escapeHtml(call.label)}</span>
                <span class="conn-detail" title="${this.escapeHtml(call.detail)}">${this.escapeHtml(call.detail)}${times}</span>
                <span class="conn-call-result ${call.status === 'error' ? 'conn-text-error' : ''}">${this.escapeHtml(result)}</span>
                <span class="conn-dot ${this.connStatusClass(call)}"></span>
            </div>`;
    },

    // Image bursts keep their file list folded away; the dashboard redraws on every poll, so which are open is remembered
    toggleBurst(id, open) {
        this.openBursts = this.openBursts || new Set();
        if (open) this.openBursts.add(id); else this.openBursts.delete(id);
    },

    apiBadge(e) {
        const api = e.api || 'LMD';
        return `<span class="conn-peer ${api === 'MB' ? 'conn-api-mb' : 'conn-api-lmd'}" title="${api === 'MB' ? 'MusicBrainz API (/ws/2)' : 'Lidarr metadata API'}">${api}</span>`;
    },

    // One request: who asked and what for. An image fetch lists its files, folded away.
    requestRow(e) {
        const calls = Array.isArray(e.calls) ? e.calls : [];
        const files = e.label === 'Image Fetch' && calls.length
            ? `<details class="conn-files" ${this.openBursts && this.openBursts.has(e.id) ? 'open' : ''} ontoggle="ui.toggleBurst(${Number(e.id)}, this.open)"><summary>files (${calls.length + (e.callsMore || 0)})</summary>${calls.map(c => this.callRow(c)).join('')}${e.callsMore ? `<div class="conn-call conn-call-more">+${e.callsMore} more</div>` : ''}</details>`
            : '';
        return `
            <div class="conn-request">
                <div class="conn-row conn-inbound">
                    <span class="conn-time">${this.connTime(e)}</span>
                    <span class="conn-direction">${this.describeClient(e)} <span class="conn-arrow">&rarr;</span> <span class="conn-peer conn-nuLMD">nuLMD</span> ${this.apiBadge(e)}</span>
                    <span class="conn-label">${this.escapeHtml(e.label)}</span>
                    <span class="conn-detail">${this.escapeHtml(e.detail)}</span>
                    <span class="conn-dot ${this.connStatusClass(e)}"></span>
                </div>
                ${files}
            </div>`;
    },

    // What nuLMD sent back for a request: the content of the reply, how it was made, how long it took, and the sources it
    // called to make it (each with its own result and time). Rows saved before replies were recorded say only answered/error.
    responseRow(e) {
        const isError = e.status === 'error';
        const how = [e.outcome, this.formatDuration(e.durationMs)].filter(Boolean).join(' · ');
        const content = e.reply || (isError ? '' : (e.outcome ? '' : 'answered'));
        const calls = e.label === 'Image Fetch' || !Array.isArray(e.calls) ? [] : e.calls;
        const shown = calls.slice(0, 3).map(c => {
            const result = [c.outcome, this.formatDuration(c.durationMs)].filter(Boolean).join(' · ');
            return `<span class="conn-chip ${this.sourceClass(c.label)} ${c.status === 'error' ? 'conn-chip-error' : ''}" title="${this.escapeHtml(c.detail)}">${this.escapeHtml(c.label)}${result ? ' ' + this.escapeHtml(result) : ''}</span>`;
        }).join(' ');
        const extra = calls.length ? Math.max(0, calls.length - 3) + (e.callsMore || 0) : 0;
        return `
            <div class="conn-response">
                <div class="conn-row conn-outbound">
                    <span class="conn-time">${this.connTime(e)}</span>
                    <span class="conn-direction"><span class="conn-peer conn-nuLMD">nuLMD</span> <span class="conn-arrow">&rarr;</span> ${this.describeClient(e)}</span>
                    <span class="conn-label">${this.escapeHtml(e.label)}</span>
                    <span class="conn-detail">${this.escapeHtml(e.detail)}</span>
                </div>
                <div class="conn-reply-body">
                    ${content ? `<span class="conn-reply-content">${this.escapeHtml(content)}</span>` : ''}
                    ${how ? `<span class="conn-reply-how ${isError ? 'conn-text-error' : ''}">${this.escapeHtml(how)}</span>` : ''}
                    ${shown}${extra > 0 ? ` <span class="conn-chip conn-client">+${extra}</span>` : ''}
                    <span class="conn-dot ${this.connStatusClass(e)}"></span>
                </div>
            </div>`;
    },

    async clearDownloadQueue() {
        if (!confirm('Mark all pending downloads as failed?')) return;
        try {
            const response = await fetch('/api/downloads/clear', { method: 'POST' });
            const data = await response.json();
            this.showSuccess(`Cleared ${data.cleared} pending downloads`);
            await this.refreshDownloadJobsCard();
        } catch (e) {
            this.showError('Failed to clear download queue');
        }
    },

    async clearJobQueue() {
        if (!confirm('Clear all pending jobs from the queue?')) return;
        try {
            const response = await fetch('/api/jobs/clear', { method: 'POST' });
            const data = await response.json();
            this.showSuccess(`Cleared ${data.cleared} pending jobs`);
            await this.refreshJobsCard();
        } catch (e) {
            this.showError('Failed to clear queue');
        }
    },

    async killActiveJobs() {
        if (!confirm('Mark all active (processing) jobs as failed? In-flight operations will still complete but results will be discarded.')) return;
        try {
            const response = await fetch('/api/jobs/kill-active', { method: 'POST' });
            const data = await response.json();
            this.showSuccess(`Killed ${data.killed} active jobs`);
            await this.refreshJobsCard();
        } catch (e) {
            this.showError('Failed to kill active jobs');
        }
    },

    async refreshAllImages() {
        if (!confirm('Queue image fetch for all artists and albums? User-uploaded images will not be affected.')) return;
        try {
            const response = await fetch('/api/images/fetch/all', { method: 'POST' });
            const data = await response.json();
            this.showSuccess(`Image fetch queued for ${data.artists} artists and ${data.albums} albums`);
        } catch (e) {
            this.showError('Failed to queue image fetch');
        }
    },

    async refreshArtistImages(mbid) {
        try {
            await fetch(`/api/images/fetch/artist/${mbid}`, { method: 'POST' });
            this.showSuccess('Image fetch queued');
        } catch (e) {
            this.showError('Failed to queue image fetch');
        }
    },

    async refreshAlbumImages(mbid) {
        try {
            await fetch(`/api/images/fetch/album/${mbid}`, { method: 'POST' });
            this.showSuccess('Image fetch queued');
        } catch (e) {
            this.showError('Failed to queue image fetch');
        }
    },

    async fetchAllAlbumImages(mbid) {
        if (!confirm('Queue image fetch for all albums of this artist? User-uploaded images will not be affected.')) return;
        try {
            const response = await fetch(`/api/images/fetch/artist-albums/${mbid}`, { method: 'POST' });
            const data = await response.json();
            this.showSuccess(`Image fetch queued for ${data.queued} albums`);
        } catch (e) {
            this.showError('Failed to queue album image fetch');
        }
    },

    startAutoRefresh() {
        // Stats always poll at 1s
        this.refreshInterval = setInterval(() => {
            if (document.getElementById('dashboard-tab').classList.contains('active')) {
                this.refreshDashboardStats();
            }
        }, 1000);

        // Jobs poll at 1s when active, 5s when idle
        this.jobsHasActive = false;
        const pollJobs = async () => {
            if (document.getElementById('dashboard-tab').classList.contains('active')) {
                await this.refreshJobsCard();
                await this.refreshDownloadJobsCard();
                await this.refreshSourcesStrip();
            }
            const interval = this.jobsHasActive ? 1000 : 5000;
            this.jobsRefreshTimeout = setTimeout(pollJobs, interval);
        };
        pollJobs();

        // Connections: poll at 2s when dashboard active
        const pollConnections = async () => {
            if (document.getElementById('dashboard-tab').classList.contains('active')) {
                await this.refreshConnectionsCard();
            }
            this.connectionsRefreshTimeout = setTimeout(pollConnections, 2000);
        };
        pollConnections();
    },

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.jobsRefreshTimeout) {
            clearTimeout(this.jobsRefreshTimeout);
            this.jobsRefreshTimeout = null;
        }
        if (this.connectionsRefreshTimeout) {
            clearTimeout(this.connectionsRefreshTimeout);
            this.connectionsRefreshTimeout = null;
        }
    },

    showSuccess(message) {
        this.showMessage(message, 'success');
    },

    showError(message) {
        this.showMessage(message, 'danger');
    },

    showMessage(message, type) {
        const alertDiv = document.createElement('div');
        alertDiv.className = `alert alert-${type} toast-notification`;
        alertDiv.textContent = message;
        alertDiv.style.position = 'fixed';
        alertDiv.style.right = '20px';
        alertDiv.style.zIndex = '1000';
        alertDiv.style.maxWidth = '400px';

        // Stack below existing toasts
        const existing = document.querySelectorAll('.toast-notification');
        let topOffset = 20;
        existing.forEach(el => {
            const rect = el.getBoundingClientRect();
            const bottom = rect.top + rect.height + 10;
            if (bottom > topOffset) topOffset = bottom;
        });
        alertDiv.style.top = topOffset + 'px';

        document.body.appendChild(alertDiv);

        setTimeout(() => {
            alertDiv.remove();
        }, 5000);
    },

};


// Export for global use
window.ui = ui;
