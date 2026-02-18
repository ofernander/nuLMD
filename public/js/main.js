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

    async getCacheStats() {
        return this.get('/cache/stats');
    },

    async flushCache() {
        return this.post('/cache/flush');
    },

    async getProviders() {
        return this.get('/providers');
    },

    async searchArtist(query, provider = null, limit = 10) {
        const params = new URLSearchParams({ query, limit });
        if (provider) params.append('provider', provider);
        // Use fetch directly - search endpoints don't use /api prefix
        const response = await fetch(`/search/artist?${params}`);
        if (!response.ok) throw new Error('Search failed');
        return response.json();
    },

    async searchAlbum(query, artist = null, provider = null, limit = 10) {
        const params = new URLSearchParams({ query, limit });
        if (artist) params.append('artist', artist);
        if (provider) params.append('provider', provider);
        // Use fetch directly - search endpoints don't use /api prefix
        const response = await fetch(`/search/album?${params}`);
        if (!response.ok) throw new Error('Search failed');
        return response.json();
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

    async getLogs(lines = 100) {
        return this.get(`/logs/tail?lines=${lines}`);
    },

    async restartServer() {
        return this.post('/restart');
    }
};

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    
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
            
            // Load tab-specific content
            if (tabName === 'browser') {
                ui.loadMetadataBrowser();
            } else if (tabName === 'sources') {
                ui.loadMetadataSources();
            } else if (tabName === 'dashboard') {
                ui.refreshDashboard();
                ui.refreshDashboardStats();
            }
        });
    });
    
    // Load initial dashboard
    await ui.refreshDashboard();
    await ui.refreshDashboardStats();
    
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