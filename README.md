# nuLMD

Metadata proxy server for Lidarr

![nuLMD](/public/assets/project_screen.png)

## What it does

- Brings functionality back to Lidarr and removes the need for the official Lidarr metadata server/LMD
- Fetches artist & album metadata directly from MusicBrainz
- Caches metadata in PostgreSQL to build local metadata cache of only the metadata you need
- Caches artist & album art, pulling from multiple sources
- Serves metadata & images to Lidarr by emulating the old Lidarr Metadata Server API

### Lidarr Disclaimer

nuLMD is not related to, supported, or endorsed by the official Lidarr dev team

## Requirements

- Docker & Docker Compose

## Installation

### Option 1: Standalone (Existing Lidarr)

```bash
git clone https://github.com/ofernander/nulmd.git
cd nulmd
docker compose up -d --build
```

Access web UI: `http://localhost:5001`

**docker-compose.yml:**
```yaml
services:
  nulmd-server:
    build: .
    container_name: nulmd-server
    hostname: nulmd-server
    ports:
      - "5001:5001"
    volumes:
      - ./config:/app/config
      - ./logs:/app/logs
      - ./data/images:/app/data/images
    environment:
      - SERVER_URL=http://localhost:5001
      - PORT=5001
      - CACHE_ENABLED=true
      - CACHE_TTL=3600
      - CACHE_MAX_SIZE=1000
      - LOG_LEVEL=info
      - POSTGRES_HOST=nulmd-db
      - POSTGRES_PORT=5432
      - POSTGRES_DB=nulmd
      - POSTGRES_USER=nulmd
      - POSTGRES_PASSWORD=changeme
      - FANART_API_KEY=
    restart: unless-stopped
    depends_on:
      nulmd-db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:5001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s
    networks:
      - nulmd_default

  nulmd-db:
    image: postgres:16-alpine
    container_name: nulmd-db
    hostname: nulmd-db
    shm_size: 512m
    command: >
      postgres
      -c shared_buffers=256MB
      -c effective_cache_size=1GB
      -c maintenance_work_mem=64MB
      -c checkpoint_completion_target=0.9
      -c wal_buffers=16MB
      -c default_statistics_target=100
      -c random_page_cost=1.1
    ports:
      - "5433:5432"
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=nulmd
      - POSTGRES_USER=nulmd
      - POSTGRES_PASSWORD=changeme
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nulmd"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - nulmd_default

networks:
  nulmd_default:
    name: nulmd_default
```

### Option 2: Combined Stack (nuLMD + Lidarr)

Deploy nuLMD and Lidarr together:

**docker-compose.yml:**
```yaml
services:
  lidarr:
    image: lscr.io/linuxserver/lidarr:nightly
    container_name: lidarr
    hostname: lidarr
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
    volumes:
      - ./lidarr-config:/config
      - /path/to/music:/music
      - /path/to/downloads:/downloads
    ports:
      - "8686:8686"
    restart: unless-stopped
    networks:
      - nulmd_default

  nulmd-server:
    build: .
    container_name: nulmd-server
    hostname: nulmd-server
    ports:
      - "5001:5001"
    volumes:
      - ./config:/app/config
      - ./logs:/app/logs
      - ./data/images:/app/data/images
    environment:
      - SERVER_URL=http://nulmd-server:5001
      - PORT=5001
      - CACHE_ENABLED=true
      - CACHE_TTL=3600
      - CACHE_MAX_SIZE=1000
      - LOG_LEVEL=info
      - POSTGRES_HOST=nulmd-db
      - POSTGRES_PORT=5432
      - POSTGRES_USER=nulmd
      - POSTGRES_PASSWORD=changeme
      - POSTGRES_DB=nulmd
      - FANART_API_KEY=
    restart: unless-stopped
    depends_on:
      nulmd-db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:5001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s
    networks:
      - nulmd_default

  nulmd-db:
    image: postgres:16-alpine
    container_name: nulmd-db
    hostname: nulmd-db
    shm_size: 512m
    command: >
      postgres
      -c shared_buffers=256MB
      -c effective_cache_size=1GB
      -c maintenance_work_mem=64MB
      -c checkpoint_completion_target=0.9
      -c wal_buffers=16MB
      -c default_statistics_target=100
      -c random_page_cost=1.1
    ports:
      - "5433:5432"
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=nulmd
      - POSTGRES_USER=nulmd
      - POSTGRES_PASSWORD=changeme
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nulmd"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - nulmd_default

networks:
  nulmd_default:
    name: nulmd_default
```



## Configuration

### Environment Variables with defaults
- SERVER_URL=http://localhost:5001
- PORT=5001
- CACHE_ENABLED=true
- CACHE_TTL=3600
- CACHE_MAX_SIZE=1000
- LOG_LEVEL=info
- POSTGRES_HOST=nulmd-db
- POSTGRES_PORT=5432
- POSTGRES_DB=nulmd
- POSTGRES_USER=nulmd
- POSTGRES_PASSWORD=password
- MUSICBRAINZ_URL=
- MUSICBRAINZ_RATE_LIMIT=
- FANART_API_KEY=

## Image Caching

Enable CoverArtArchive and Fanart in the settings to have nuLMD cache images locally. Lidarr will first try to grab the images from nuLMD then
if not found will attempt to download from the source

### CoverArtArchive.org

Pulls album cover artwork from `https://coverartarchive.org/`

### Fanart.tv

Pulls artist related artwork from `https://fanart.tv`

Add to `docker-compose.yml` or enable within the UI

```yaml
environment:
  - FANART_API_KEY=your_key_here
```

Get a key: `https://fanart.tv/get-an-api-key/`

## Custom MusicBrainz Server

Enter URL of local MB host. Typically `http://localhost:5000`
Set rate limit to 0 for none

- MUSICBRAINZ_URL=
- MUSICBRAINZ_RATE_LIMIT=0

## Lidarr Setup

You need the nightly Lidarr image from lscr.io/linuxserver/lidarr:nightly which has plugins enabled

Install the Tubifarry plugin https://github.com/TypNull/Tubifarry

Settings → Metadata Sources → Import Lists → Custom

URL stand alone - `http://localhost:5001`
URL with stack - `http://nulmd-server:5001`

