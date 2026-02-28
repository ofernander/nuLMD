const JOB_LABELS = {
    fetch_artist:        'Artist Metadata',
    fetch_artist_albums: 'Artist Albums',
    fetch_artist_wiki:   'Artist Wiki',
    fetch_artist_images: 'Artist Images',
    fetch_release:       'Release Data',
    fetch_album_full:    'Album Releases',
    fetch_album_wiki:    'Album Wiki',
    fetch_album_images:  'Album Images',
    artist_full:         'Full Artist Fetch',
    artist_releases:     'Artist Releases',
    release_tracks:      'Track Data',
    download_image:      'Image Download'
};

// UI management functions
const ui = {
    refreshInterval: null,

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
            document.getElementById('dashboardAlbumCount').textContent = stats.database.albums.toLocaleString();
            document.getElementById('dashboardReleaseCount').textContent = stats.database.releases.toLocaleString();
            document.getElementById('dashboardTrackCount').textContent = stats.database.tracks.toLocaleString();
            document.getElementById('dashboardMemoryUsage').textContent = `${stats.memory.used_mb} MB`;
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
                
                // MusicBrainz: No enable toggle, just custom URL + fetch type config
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
                    
                    // API Key field — show for any provider that has apiKey, token, or clientSecret in config,
                    // or for known providers that need keys
                    const needsApiKey = ['fanart', 'lastfm', 'discogs'];
                    if (settings.apiKey !== undefined || needsApiKey.includes(name)) {
                        html += '<div class="form-group">';
                        html += `<label for="providers.${name}.apiKey">API Key</label>`;
                        const displayValue = settings.apiKey && settings.apiKey !== '' ? settings.apiKey : '';
                        html += `<input type="text" class="form-control" id="providers.${name}.apiKey" value="${displayValue}" placeholder="Enter API key">`;
                        html += '</div>';
                    }
                }
                
                html += '</div>';
            }

            // Lidarr Integration card (separate from providers)
            const lidarrInt = config.lidarrIntegration || {};
            html += '<div class="card" style="margin-bottom: 15px;">';
            html += '<h3>Lidarr Integration</h3>';
            html += '<small class="form-text" style="display:block; margin-bottom: 1rem;">Connect to your Lidarr instance to trigger automatic metadata refreshes after nuLMD fetches new data.</small>';
            html += '<div class="form-group">';
            html += '<label for="lidarrIntegration.enabled">';
            html += `<input type="checkbox" id="lidarrIntegration.enabled" ${lidarrInt.enabled ? 'checked' : ''}> Enabled`;
            html += '</label>';
            html += '</div>';
            html += '<div class="form-group">';
            html += '<label for="lidarrIntegration.url">Lidarr URL</label>';
            html += `<input type="text" class="form-control" id="lidarrIntegration.url" value="${lidarrInt.url || ''}" placeholder="http://localhost:8686">`;
            html += '</div>';
            html += '<div class="form-group">';
            html += '<label for="lidarrIntegration.apiKey">API Key</label>';
            html += `<input type="text" class="form-control" id="lidarrIntegration.apiKey" value="${lidarrInt.apiKey || ''}" placeholder="Lidarr API key (Settings → General)">`;
            html += '</div>';
            html += '<div style="margin-top: 0.75rem;">';
            html += '<button class="btn btn-secondary" onclick="ui.testLidarrConnection()">Test Connection</button>';
            html += '<span id="lidarrTestResult" style="margin-left: 0.75rem; font-size: 0.85rem;"></span>';
            html += '</div>';
            html += '</div>';

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
                            ${this.escapeHtml(artist.name)}
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
                    <td><button class="btn-refresh" onclick="event.stopPropagation(); ui.refreshAlbumMetadata('${album.mbid}', '${artistMbid}')">Fetch</button></td>
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
                    ${this.escapeHtml(artist.name)}
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
                    ${this.escapeHtml(artist.name)}
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
            const config = { providers: {} };

            // Collect lidarrIntegration fields
            const lidarrInt = {};
            const lidarrEnabled = document.getElementById('lidarrIntegration.enabled');
            const lidarrUrl = document.getElementById('lidarrIntegration.url');
            const lidarrApiKey = document.getElementById('lidarrIntegration.apiKey');
            if (lidarrEnabled) lidarrInt.enabled = lidarrEnabled.checked;
            if (lidarrUrl) lidarrInt.url = lidarrUrl.value;
            if (lidarrApiKey && lidarrApiKey.value && !lidarrApiKey.value.endsWith('***')) {
                lidarrInt.apiKey = lidarrApiKey.value;
            }
            if (Object.keys(lidarrInt).length > 0) config.lidarrIntegration = lidarrInt;

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
                    // Don't save masked values (contain ***)
                    if (input.value && !input.value.endsWith('***') && input.value !== '') {
                        config.providers[providerName][key] = input.value;
                    }
                }
            });

            await api.updateConfig(config);
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
                const overview = result.Overview || '<em style="color: var(--text-secondary)">No overview available</em>';
                const type = result.Type || '-';
                const country = result.Country || '-';
                html += `
                    <tr>
                        <td><strong>${this.escapeHtml(result.ArtistName)}</strong>${result.Disambiguation ? '<br><small style="color:var(--text-secondary)">' + this.escapeHtml(result.Disambiguation) + '</small>' : ''}</td>
                        <td>${this.escapeHtml(type)}</td>
                        <td>${this.escapeHtml(country)}</td>
                        <td style="max-width: 400px; font-size: 0.85rem;">${this.escapeHtml(typeof overview === 'string' ? overview.substring(0, 300) + (overview.length > 300 ? '...' : '') : '')}</td>
                        <td><button class="btn btn-primary" onclick="ui.fetchArtistFromSearch('${result.Id}', this)">Fetch</button></td>
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

    // ─── Lidarr Integration ─────────────────────────────────────────────────

    async testLidarrConnection() {
        const resultEl = document.getElementById('lidarrTestResult');
        resultEl.textContent = 'Testing...';
        resultEl.style.color = 'var(--text-secondary)';

        try {
            const url = document.getElementById('lidarrIntegration.url')?.value || '';
            const apiKey = document.getElementById('lidarrIntegration.apiKey')?.value || '';
            const enabled = document.getElementById('lidarrIntegration.enabled')?.checked || false;

            if (!url || !apiKey) {
                resultEl.textContent = '✘ URL and API key required';
                resultEl.style.color = '#f05050';
                return;
            }

            // Save config first so the server has the latest values
            const saveConfig = { lidarrIntegration: { enabled, url } };
            if (!apiKey.endsWith('***')) saveConfig.lidarrIntegration.apiKey = apiKey;
            await api.updateConfig(saveConfig);

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
            this._renderImageArtistList(this.imageArtists);
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
        await this.loadLogFileList();
        // Auto-select most recent file (first in list, sorted by modified desc)
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
        this.lastLogLength = 0;

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
            const response = await fetch(`/api/logs/file?name=${encodeURIComponent(filename)}&tail=500`);
            if (!response.ok) throw new Error('Failed to load file');
            const logs = await response.json();

            if (logs.length === 0) {
                viewer.innerHTML = '<div class="log-empty">No log entries</div>';
                return;
            }

            viewer.innerHTML = logs.map(log => this.formatLogLine(log)).join('');
            viewer.scrollTop = viewer.scrollHeight;
        } catch (error) {
            viewer.innerHTML = `<div class="log-empty">Failed to load ${filename}</div>`;
        }
    },

    async refreshJobsCard() {
        try {
            const response = await fetch('/api/jobs/recent');
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
                        </div>` : '';
                }

                const artistPrefix = job.artist_name
                    ? `<span class="job-artist-name">${this.escapeHtml(job.artist_name)}</span> — `
                    : '';

                return `
                    <div class="job-row">
                        <div class="job-row-header">
                            <span class="job-label">${artistPrefix}${this.escapeHtml(displayName)} <span class="job-type-badge">${label}</span></span>
                            <span class="job-status job-status-${job.status}">${job.status}</span>
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
        if (!confirm('Re-fetch images for this artist? User-uploaded images will not be affected.')) return;
        try {
            await fetch(`/api/images/fetch/artist/${mbid}`, { method: 'POST' });
            this.showSuccess('Image fetch queued');
        } catch (e) {
            this.showError('Failed to queue image fetch');
        }
    },

    async refreshAlbumImages(mbid) {
        if (!confirm('Re-fetch images for this album? User-uploaded images will not be affected.')) return;
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
            }
            const interval = this.jobsHasActive ? 1000 : 5000;
            this.jobsRefreshTimeout = setTimeout(pollJobs, interval);
        };
        pollJobs();
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
