const JOB_LABELS = {
    fetch_artist:        'Artist',
    fetch_artist_albums: 'Albums',
    fetch_release:       'Release',
    fetch_album_full:    'Full Album',
    artist_full:         'Artist (Full)',
    artist_releases:     'Artist Releases',
    release_tracks:      'Track Data',
    download_image:      'Image'
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

                    const fetchTypes = config.metadata?.fetchTypes || {};
                    const activeAlbumTypes = fetchTypes.albumTypes || ['Studio'];
                    const activeStatuses = fetchTypes.releaseStatuses || ['Official'];

                    html += '<div class="form-group">';
                    html += '<label>Release Types to Fetch <small class="form-text" style="display:inline; margin-left: 0.5rem;">Applied when Lidarr requests an artist — explicit album requests always fetch regardless</small></label>';
                    html += '<div style="margin-top: 0.5rem;">';
                    html += '<strong style="font-size: 0.85rem; color: var(--text-secondary); display: block; margin-bottom: 0.4rem;">Release Types</strong>';
                    html += '<div style="display: flex; flex-wrap: wrap; gap: 0.75rem;">';
                    for (const type of ['Studio', 'Single', 'EP', 'Live', 'Compilation', 'Soundtrack', 'Remix', 'DJ-mix', 'Mixtape', 'Demo', 'Spokenword', 'Interview', 'Audiobook', 'Audio drama', 'Field recording', 'Broadcast', 'Other']) {
                        const checked = activeAlbumTypes.includes(type) ? 'checked' : '';
                        html += `<label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;"><input type="checkbox" class="fetch-type-album" value="${type}" ${checked}> ${type}</label>`;
                    }
                    html += '</div>';
                    html += '<strong style="font-size: 0.85rem; color: var(--text-secondary); display: block; margin: 0.75rem 0 0.4rem;">Release Statuses</strong>';
                    html += '<div style="display: flex; flex-wrap: wrap; gap: 0.75rem;">';
                    for (const status of ['Official', 'Promotion', 'Bootleg', 'Pseudo-Release']) {
                        const checked = activeStatuses.includes(status) ? 'checked' : '';
                        html += `<label style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;"><input type="checkbox" class="fetch-type-status" value="${status}" ${checked}> ${status}</label>`;
                    }
                    html += '</div>';
                    html += '</div>';
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

    async loadMetadataBrowser() {
        // Load metadata tree
        await this.loadMetadataTree();
        
        // Load refresh settings
        await this.loadRefreshSettings();
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
                <div class="metadata-search">
                    <input type="text" id="metadataSearchInput" placeholder="Search artists..." onkeyup="ui.filterMetadataTree()">
                    <select id="albumTypeFilter" onchange="ui.applyFilters()" style="margin-left: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
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
                    <select id="releaseStatusFilter" onchange="ui.applyFilters()" style="margin-left: 0.5rem; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
                        <option value="all">All Release Types</option>
                        <option value="Official" selected>Official Only</option>
                        <option value="Promotion">Promotional Only</option>
                        <option value="Bootleg">Bootleg Only</option>
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
                        <td><button class="btn-refresh" onclick="ui.refreshArtistMetadata('${artist.mbid}')">Fetch</button></td>
                    </tr>
                `;
            }

            html += `
                        </tbody>
                    </table>
                </div>
            `;

            container.innerHTML = html;

            // Sort alphabetically before storing
            artists.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));

            // Store artists data - always reset sort to alphabetical on load
            this.metadataArtists = artists;
            this.metadataSort = { column: 'name', direction: 'asc' };
            this.currentAlbumTypeFilter = this.currentAlbumTypeFilter || 'Album';
            this.currentReleaseStatusFilter = this.currentReleaseStatusFilter || 'Official';

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
    },

    rebuildMetadataTable() {
        const container = document.getElementById('metadataTree');
        if (!container) return;
        
        // Rebuild entire table structure
        let html = `
            <div class="metadata-search">
                <input type="text" id="metadataSearchInput" placeholder="Search artists..." onkeyup="ui.filterMetadataTree()">
                <select id="albumTypeFilter" onchange="ui.applyFilters()" style="margin-left: 1rem; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
                    <option value="all" ${this.currentAlbumTypeFilter === 'all' ? 'selected' : ''}>All Types</option>
                    <option value="Album" ${this.currentAlbumTypeFilter === 'Album' ? 'selected' : ''}>Studio Albums</option>
                    <option value="EP" ${this.currentAlbumTypeFilter === 'EP' ? 'selected' : ''}>EPs</option>
                    <option value="Single" ${this.currentAlbumTypeFilter === 'Single' ? 'selected' : ''}>Singles</option>
                    <option value="Live" ${this.currentAlbumTypeFilter === 'Live' ? 'selected' : ''}>Live</option>
                    <option value="Compilation" ${this.currentAlbumTypeFilter === 'Compilation' ? 'selected' : ''}>Compilations</option>
                    <option value="Soundtrack" ${this.currentAlbumTypeFilter === 'Soundtrack' ? 'selected' : ''}>Soundtracks</option>
                    <option value="Spokenword" ${this.currentAlbumTypeFilter === 'Spokenword' ? 'selected' : ''}>Spokenword</option>
                    <option value="Interview" ${this.currentAlbumTypeFilter === 'Interview' ? 'selected' : ''}>Interviews</option>
                    <option value="Audiobook" ${this.currentAlbumTypeFilter === 'Audiobook' ? 'selected' : ''}>Audiobooks</option>
                    <option value="Audio drama" ${this.currentAlbumTypeFilter === 'Audio drama' ? 'selected' : ''}>Audio Dramas</option>
                    <option value="Remix" ${this.currentAlbumTypeFilter === 'Remix' ? 'selected' : ''}>Remixes</option>
                    <option value="DJ-mix" ${this.currentAlbumTypeFilter === 'DJ-mix' ? 'selected' : ''}>DJ Mixes</option>
                    <option value="Mixtape/Street" ${this.currentAlbumTypeFilter === 'Mixtape/Street' ? 'selected' : ''}>Mixtapes</option>
                    <option value="Demo" ${this.currentAlbumTypeFilter === 'Demo' ? 'selected' : ''}>Demos</option>
                </select>
                    <select id="releaseStatusFilter" onchange="ui.applyFilters()" style="margin-left: 0.5rem; padding: 0.75rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 0.375rem; color: var(--text);">
                        <option value="all" ${this.currentReleaseStatusFilter === 'all' ? 'selected' : ''}>All Release Types</option>
                        <option value="Official" ${this.currentReleaseStatusFilter === 'Official' ? 'selected' : ''}>Official Only</option>
                        <option value="Promotion" ${this.currentReleaseStatusFilter === 'Promotion' ? 'selected' : ''}>Promotional Only</option>
                        <option value="Bootleg" ${this.currentReleaseStatusFilter === 'Bootleg' ? 'selected' : ''}>Bootleg Only</option>
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
        
        for (const artist of this.metadataArtists) {
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
                    <td><button class="btn-refresh" onclick="ui.refreshArtistMetadata('${artist.mbid}')">Fetch</button></td>
                </tr>
            `;
        }
        
        html += `
                    </tbody>
                </table>
            </div>
        `;
        
        container.innerHTML = html;
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
                <td><span class="mbid-copy" onclick="event.stopPropagation(); ui.copyToClipboard('${artist.mbid}')" title="Click to copy MBID">${artist.mbid.substring(0, 8)}...</span></td>
                <td>${artist.type || '-'}</td>
                <td>${artist.country || '-'}</td>
                <td>${artist.album_count}</td>
                <td>${artist.release_count}</td>
                <td>${artist.track_count}</td>
                <td>${lastUpdated}</td>
                <td><button class="btn-refresh" onclick="ui.refreshArtistMetadata('${artist.mbid}')">Fetch</button></td>
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

    async loadRefreshSettings() {
        const statusDiv = document.getElementById('refreshStatus');
        const formDiv = document.getElementById('refreshSettingsForm');

        try {
            const [status, config] = await Promise.all([
                fetch('/api/refresh/status').then(r => r.json()),
                api.getConfig()
            ]);

            // Display status
            let statusHtml = '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px;">';
            
            if (status.lastRefresh) {
                const lastRefreshDate = new Date(status.lastRefresh).toLocaleDateString();
                statusHtml += `<div><strong>Last Bulk Refresh:</strong> ${lastRefreshDate}</div>`;
                statusHtml += `<div><strong>Days Since Refresh:</strong> ${status.daysSinceRefresh}</div>`;
                statusHtml += `<div><strong>Next Refresh Due:</strong> ${status.nextRefreshDue} days</div>`;
            } else {
                statusHtml += '<div><strong>Last Bulk Refresh:</strong> Never</div>';
                statusHtml += '<div><strong>Next Refresh Due:</strong> On next scheduled check</div>';
            }
            
            statusHtml += '</div>';
            statusDiv.innerHTML = statusHtml;

            // Display settings form
            const artistTTL = config.refresh?.artistTTL || 7;
            const bulkInterval = config.refresh?.bulkRefreshInterval || 180;

            let formHtml = '';
            formHtml += '<div class="form-group">';
            formHtml += '<label for="refresh.artistTTL">Artist TTL (days)</label>';
            formHtml += `<input type="number" class="form-control" id="refresh.artistTTL" value="${artistTTL}" min="1" max="365">`;
            formHtml += '<small class="form-text">Days before artist data expires and refreshes on next access</small>';
            formHtml += '</div>';

            formHtml += '<div class="form-group">';
            formHtml += '<label for="refresh.bulkRefreshInterval">Bulk Refresh Interval (days)</label>';
            formHtml += `<input type="number" class="form-control" id="refresh.bulkRefreshInterval" value="${bulkInterval}" min="1" max="365">`;
            formHtml += '<small class="form-text">Days between automatic bulk refresh of all artists</small>';
            formHtml += '</div>';

            formHtml += '<div style="display: flex; gap: 10px;">';
            formHtml += '<button class="btn btn-primary" onclick="ui.saveRefreshSettings()">Save Settings</button>';
            formHtml += `<button class="btn btn-secondary" onclick="ui.triggerBulkRefresh()" ${status.isRunning ? 'disabled' : ''}>Refresh All Artists Now</button>`;
            formHtml += '</div>';

            formDiv.innerHTML = formHtml;

        } catch (error) {
            console.error('Failed to load refresh settings:', error);
            statusDiv.innerHTML = '<p class="alert alert-danger">Failed to load refresh status</p>';
            formDiv.innerHTML = '';
        }
    },

    async saveRefreshSettings() {
        try {
            const config = {
                refresh: {
                    artistTTL: parseInt(document.getElementById('refresh.artistTTL').value),
                    bulkRefreshInterval: parseInt(document.getElementById('refresh.bulkRefreshInterval').value)
                }
            };

            await api.updateConfig(config);
            this.showSuccess('Refresh settings saved. Restart required.');
        } catch (error) {
            console.error('Failed to save refresh settings:', error);
            this.showError('Failed to save refresh settings');
        }
    },

    async triggerBulkRefresh() {
        if (!confirm('Start bulk refresh of all artists? This may take a while.')) {
            return;
        }

        try {
            const response = await fetch('/api/refresh/all', { method: 'POST' });
            if (!response.ok) throw new Error('Bulk refresh failed');
            
            this.showSuccess('Bulk refresh started in background');
            
            // Reload settings to show updated status
            setTimeout(() => this.loadRefreshSettings(), 1000);
        } catch (error) {
            console.error('Failed to trigger bulk refresh:', error);
            this.showError('Failed to start bulk refresh');
        }
    },

    async saveMetadataSources() {
        try {
            const config = { providers: {}, metadata: { fetchTypes: { albumTypes: [], releaseStatuses: [] } } };
            
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

            // Collect fetch type checkboxes
            document.querySelectorAll('.fetch-type-album:checked').forEach(cb => {
                config.metadata.fetchTypes.albumTypes.push(cb.value);
            });
            document.querySelectorAll('.fetch-type-status:checked').forEach(cb => {
                config.metadata.fetchTypes.releaseStatuses.push(cb.value);
            });

            await api.updateConfig(config);
            this.showSuccess('Metadata sources saved. Changes take effect immediately.');
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
        const filtered = (this.imageArtists || []).filter(a => a.name.toLowerCase().includes(q));
        this._renderImageArtistList(filtered);
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
            html += `<button class="btn btn-secondary" onclick="ui.showUploadForm('artist', '${mbid}', null)">Upload Image</button>`;
            html += '</div>';
            html += this._renderImageGrid(artistImages, 'artist');
            html += '</div>';

            // Albums
            if (albums.length > 0) {
                html += '<div class="card">';
                html += '<h2>Album Images</h2>';
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
                                <button class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.3rem 0.75rem;" onclick="ui.showUploadForm('album', '${album.mbid}', '${album.mbid}')">Upload Image</button>
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

                const albumCount   = parseInt(job.album_count) || 0;
                const releaseCount = parseInt(job.release_count) || 0;
                const trackCount   = parseInt(job.track_count) || 0;
                const hasCounts    = albumCount > 0 || releaseCount > 0 || trackCount > 0;
                const countsHtml   = hasCounts ? `
                    <div class="job-counts">
                        ${albumCount   > 0 ? `<span>${albumCount} albums</span>` : ''}
                        ${releaseCount > 0 ? `<span>${releaseCount} releases</span>` : ''}
                        ${trackCount   > 0 ? `<span>${trackCount} tracks</span>` : ''}
                    </div>` : '';

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
                        ${countsHtml}
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

};


// Export for global use
window.ui = ui;
