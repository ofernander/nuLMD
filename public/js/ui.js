// UI management functions
const ui = {
    refreshInterval: null,
    logAutoScroll: true,
    lastLogLength: 0,
    minVisibleLogs: 50,  // Minimum number of log lines to keep visible

    async refreshDashboard() {
        try {
            const [providers, config] = await Promise.all([
                api.getProviders(),
                api.getConfig()
            ]);
            
            // Load debug toggle state
            try {
                const logLevelResponse = await fetch('/api/log-level');
                const logLevelData = await logLevelResponse.json();
                const debugToggle = document.getElementById('debugToggle');
                if (debugToggle) {
                    debugToggle.checked = logLevelData.level === 'debug';
                }
            } catch (error) {
                console.error('Failed to load log level:', error);
            }

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
            document.getElementById('dashboardArtistCount').textContent = stats.database.artists.toLocaleString();
            document.getElementById('dashboardAlbumCount').textContent = stats.database.albums.toLocaleString();
            document.getElementById('dashboardTrackCount').textContent = stats.database.tracks.toLocaleString();
            document.getElementById('dashboardMemoryUsage').textContent = `${stats.memory.used_mb} MB`;
        } catch (error) {
            console.error('Failed to refresh dashboard stats:', error);
        }
    },

    async refreshLogs() {
        try {
            const logs = await api.getLogs();
            const viewer = document.getElementById('logViewer');
            
            // Always update if logs changed
            if (logs.length !== this.lastLogLength) {
                if (logs.length === 0) {
                    // No logs after filtering - keep showing last state, don't clear
                    // Only clear on very first load or explicit clear button
                    if (this.lastLogLength === 0) {
                        viewer.innerHTML = '';
                    }
                } else {
                    // Only show the last N logs to prevent UI slowdown
                    const logsToShow = logs.slice(-this.minVisibleLogs);
                    viewer.innerHTML = logsToShow.map(log => this.formatLogLine(log)).join('');
                    this.lastLogLength = logs.length;
                    
                    // Auto-scroll to bottom if enabled
                    if (this.logAutoScroll) {
                        viewer.scrollTop = viewer.scrollHeight;
                    }
                }
            }
        } catch (error) {
            console.error('Failed to refresh logs:', error);
            const viewer = document.getElementById('logViewer');
            if (!viewer.querySelector('.log-loading')) {
                viewer.innerHTML = '<div class="log-empty">Failed to load logs</div>';
            }
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

    toggleLogAutoScroll() {
        this.logAutoScroll = !this.logAutoScroll;
        const btn = document.getElementById('autoScrollBtn');
        btn.textContent = `Auto-scroll: ${this.logAutoScroll ? 'ON' : 'OFF'}`;
        
        if (this.logAutoScroll) {
            const viewer = document.getElementById('logViewer');
            viewer.scrollTop = viewer.scrollHeight;
        }
    },

    clearLogs() {
        const viewer = document.getElementById('logViewer');
        viewer.innerHTML = '';
        this.lastLogLength = 0;
    },

    async loadMetadataSources() {
        const container = document.getElementById('metadataSourcesForm');
        container.innerHTML = '<p>Loading metadata sources...</p>';

        try {
            const config = await api.getConfig();
            
            let html = '';

            // Skip mandatory providers and non-functional providers
            const skipProviders = ['wikipedia', 'theaudiodb'];

            // Create cards for each provider
            for (const [name, settings] of Object.entries(config.providers || {})) {
                // Skip providers
                if (skipProviders.includes(name)) continue;

                const providerName = name.charAt(0).toUpperCase() + name.slice(1);
                
                html += `<div class="card" style="margin-bottom: 15px;">`;
                html += `<h3>${providerName}</h3>`;
                
                // MusicBrainz: No enable toggle, just custom URL
                if (name === 'musicbrainz') {
                    html += '<div class="form-group">';
                    html += `<label for="providers.${name}.baseUrl">Custom Server URL (optional)</label>`;
                    html += `<input type="text" class="form-control" id="providers.${name}.baseUrl" value="${settings.baseUrl || ''}" placeholder="https://musicbrainz.org/ws/2">`;
                    html += '<small class="form-text">Leave empty to use default MusicBrainz server</small>';
                    html += '</div>';
                } else {
                    // Other providers: Show enable toggle
                    html += '<div class="form-group">';
                    html += `<label for="providers.${name}.enabled">`;
                    html += `<input type="checkbox" id="providers.${name}.enabled" `;
                    html += `${settings.enabled ? 'checked' : ''}> Enabled`;
                    html += '</label>';
                    html += '</div>';
                    
                    // API Key if exists
                    if (settings.apiKey !== undefined) {
                        html += '<div class="form-group">';
                        html += `<label for="providers.${name}.apiKey">API Key</label>`;
                        const displayValue = settings.apiKey && settings.apiKey !== '' ? '***' : '';
                        html += `<input type="text" class="form-control" id="providers.${name}.apiKey" value="${displayValue}" placeholder="Enter API key">`;
                        html += '</div>';
                    }
                }
                
                html += '</div>';
            }

            html += '<div style="display: flex; gap: 10px;">';
            html += '<button class="btn btn-primary" onclick="ui.saveMetadataSources()">Save Configuration</button>';
            html += '<button class="btn btn-secondary" onclick="ui.restartServer()">Restart Server</button>';
            html += '</div>';
            
            container.innerHTML = html;
        } catch (error) {
            console.error('Failed to load metadata sources:', error);
            container.innerHTML = '<p class="alert alert-danger">Failed to load metadata sources</p>';
        }
    },



    async saveMetadataSources() {
        try {
            const config = { providers: {} };
            
            // Collect all provider form values
            document.querySelectorAll('#metadataSourcesForm input, #metadataSourcesForm select').forEach(input => {
                const path = input.id.split('.');
                if (path[0] !== 'providers') return;
                
                const providerName = path[1];
                const key = path[2];
                
                if (!config.providers[providerName]) {
                    config.providers[providerName] = {};
                }
                
                if (input.type === 'checkbox') {
                    config.providers[providerName][key] = input.checked;
                } else if (input.type === 'number') {
                    config.providers[providerName][key] = parseFloat(input.value);
                } else {
                    // Don't save masked values
                    if (input.value !== '***' && input.value !== '') {
                        config.providers[providerName][key] = input.value;
                    }
                }
            });

            await api.updateConfig(config);
            this.showSuccess('Metadata sources saved successfully. Restart required.');
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
        const searchType = document.getElementById('testSearchType').value;
        const provider = document.getElementById('testProvider').value;
        const query = document.getElementById('testQuery').value;
        const limit = parseInt(document.getElementById('testLimit').value);
        const resultsDiv = document.getElementById('testResults');

        if (!query) {
            resultsDiv.innerHTML = '<p class="alert alert-danger">Please enter a search query</p>';
            return;
        }

        resultsDiv.innerHTML = '<p>Searching and fetching full metadata from MusicBrainz...</p>';

        try {
            let searchResults;
            if (searchType === 'artist') {
                searchResults = await api.searchArtist(query, provider || null, limit);
            } else {
                searchResults = await api.searchAlbum(query, null, provider || null, limit);
            }

            // Now fetch FULL data for each result (mimics what Lidarr does)
            resultsDiv.innerHTML = '<p>Found ' + searchResults.length + ' results. Fetching full metadata...</p>';
            
            const fullResults = [];
            for (const result of searchResults) {
                try {
                    let fullData;
                    if (searchType === 'artist') {
                        // Fetch full artist data via the API endpoint Lidarr would use
                        const response = await fetch(`/artist/${result.Id}`);
                        fullData = await response.json();
                    } else {
                        // Fetch full album data
                        const response = await fetch(`/album/${result.Id}`);
                        fullData = await response.json();
                    }
                    fullResults.push(fullData);
                } catch (error) {
                    console.error(`Failed to fetch full data for ${result.Id}:`, error);
                    fullResults.push({ ...result, _error: 'Failed to fetch full data' });
                }
            }

            // Display results with section headers
            let html = `
                <div class="alert alert-info">
                    Showing FULL API response
                </div>
                <h3>Results (${fullResults.length})</h3>
                <pre>${JSON.stringify(fullResults, null, 2)}</pre>
            `;
            
            resultsDiv.innerHTML = html;
        } catch (error) {
            console.error('Search failed:', error);
            resultsDiv.innerHTML = `<p class="alert alert-danger">Search failed: ${error.message}</p>`;
        }
    },

    startAutoRefresh() {
        // Refresh appropriate tab content
        this.refreshInterval = setInterval(() => {
            if (document.getElementById('dashboard-tab').classList.contains('active')) {
                this.refreshLogs();
                this.refreshDashboardStats();
            }
        }, 500);
    },

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
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
        alertDiv.className = `alert alert-${type}`;
        alertDiv.textContent = message;
        alertDiv.style.position = 'fixed';
        alertDiv.style.top = '20px';
        alertDiv.style.right = '20px';
        alertDiv.style.zIndex = '1000';
        alertDiv.style.maxWidth = '400px';

        document.body.appendChild(alertDiv);

        setTimeout(() => {
            alertDiv.remove();
        }, 5000);
    },

    async toggleDebugLogging(enabled) {
        try {
            const level = enabled ? 'debug' : 'info';
            const response = await fetch('/api/log-level', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ level })
            });
            
            if (!response.ok) throw new Error('Failed to set log level');
            
            this.showSuccess(`Debug logging ${enabled ? 'enabled' : 'disabled'}`);
        } catch (error) {
            console.error('Failed to toggle debug logging:', error);
            this.showError('Failed to change log level');
            // Revert checkbox
            document.getElementById('debugToggle').checked = !enabled;
        }
    }
};

// Export for global use
window.ui = ui;
