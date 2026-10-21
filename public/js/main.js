// Main API client
const api = {
    baseUrl: '/api',

    async request(endpoint, options = {}) {
        try {
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Request failed');
            }

            return await response.json();
        } catch (error) {
            console.error('API request failed:', error);
            throw error;
        }
    },

    async get(endpoint) {
        return this.request(endpoint);
    },

    async post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    },

    // Specific API methods
    async getVersion() {
        return this.get('/version');
    },

    async getStats() {
        return this.get('/stats');
    },

    async getConfig() {
        return this.get('/config');
    },

    async updateConfig(data) {
        return this.post('/config', data);
    },

    async getProviders() {
        return this.get('/providers');
    },

    async searchArtist(query, limit = 10) {
        const params = new URLSearchParams({ query, limit, type: 'all' });
        const response = await fetch(`/search?${params}`);
        if (!response.ok) throw new Error('Search failed');
        const results = await response.json();
        // Filter to artist results only, unwrap from { album, artist, score } wrapper
        return results.filter(r => r.artist !== null).map(r => r.artist);
    },

    async getArtist(mbid) {
        // Use fetch directly - artist endpoint doesn't use /api prefix
        const response = await fetch(`/artist/${mbid}`);
        if (!response.ok) throw new Error('Artist fetch failed');
        return response.json();
    },

    async getAlbum(mbid) {
        // Use fetch directly - album endpoint doesn't use /api prefix
        const response = await fetch(`/album/${mbid}`);
        if (!response.ok) throw new Error('Album fetch failed');
        return response.json();
    },

    async getAlbumTracks(provider, id) {
        return this.get(`/album/${provider}/${id}/tracks`);
    },

    async restartServer() {
        return this.post('/restart');
    }
};

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {

    // Header Controls menu: opens on click and stays open while you work (the trim and restart items show their progress
    // on themselves); closes on a click outside it or Esc
    const controlsMenu = document.getElementById('controlsMenu');
    if (controlsMenu) {
        const trigger = controlsMenu.querySelector('.menu-trigger');
        const panel = controlsMenu.querySelector('.menu-panel');
        const setOpen = open => { panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); };
        trigger.addEventListener('click', () => setOpen(panel.hidden));
        document.addEventListener('click', e => { if (!controlsMenu.contains(e.target)) setOpen(false); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    }

    // Setup tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            
            // Update tab buttons
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(`${tabName}-tab`).classList.add('active');
            
            // Stop log polling when leaving logs tab
            if (tabName !== 'logs') ui._stopLogPolling();

            // Load tab-specific content
            if (tabName === 'browser') {
                ui.loadMetadataBrowser();
            } else if (tabName === 'sources') {
                ui.refreshDashboard();
                ui.loadMetadataSources();
            } else if (tabName === 'dashboard') {
                ui.refreshDashboard();
                ui.refreshDashboardStats();
            } else if (tabName === 'logs') {
                ui.loadLogsTab();
            } else if (tabName === 'images') {
                ui.loadImagesTab();
            } else if (tabName === 'settings') {
                ui.loadSettingsTab();
            }
        });
    });
    
    // Load initial dashboard
    await ui.refreshDashboard();
    await ui.refreshDashboardStats();
    await ui.refreshJobsCard();
    
    // Start auto-refresh
    ui.startAutoRefresh();
});

async function checkStatus() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    try {
        const health = await fetch('/health');
        if (health.ok) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
        } else {
            statusDot.classList.add('error');
            statusText.textContent = 'Error';
        }
    } catch (error) {
        statusDot.classList.add('error');
        statusText.textContent = 'Disconnected';
        console.error('Status check failed:', error);
    }
}

// Export for use in other scripts
window.api = api;