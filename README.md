# nuLMD

Lidarr Metadata Proxy & Caching Server

![nuLMD](/public/assets/project_screen.png)

## What it does

- Replaces the official Lidarr metadata server
- Fetches artist & album metadata directly from MusicBrainz
- Caches metadata in PostgreSQL database locally to build metadata cache of only the metadata you need (creates smaller MusicBrainz database)
- Caches artist & album art to serve to Lidarr locally
- Also speaks MusicBrainz's own web service, so other tools (Picard, beets, scripts) can use your nuLMD as a local, caching MusicBrainz server


## A.I. Disclosure 
Coding agents were used for the development of this project with oversight and understanding of all core functions.

## Requirements

- Docker & Docker Compose

## Installation

### Option 1: Standalone (Existing Lidarr)

Create a `docker-compose.yml` and run:

```bash
docker compose up -d
```

Access web UI: `http://localhost:5001`

**docker-compose.yml:**
```yaml
services:
  nulmd-server:
    image: ghcr.io/ofernander/nulmd:latest
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
      - LOG_LEVEL=info
      - POSTGRES_HOST=nulmd-db
      - POSTGRES_PORT=5432
      - POSTGRES_DB=nulmd
      - POSTGRES_USER=nulmd
      - POSTGRES_PASSWORD=changeme
      - LIDARR_URL=http://<lidarr-URL>:8686
      - LIDARR_API_KEY=
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
      - "5432:5432"
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
    image: ghcr.io/ofernander/nulmd:latest
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
      - LOG_LEVEL=info
      - POSTGRES_HOST=nulmd-db
      - POSTGRES_PORT=5432
      - POSTGRES_USER=nulmd
      - POSTGRES_PASSWORD=changeme
      - POSTGRES_DB=nulmd
      - LIDARR_URL=http://lidarr:8686
      - LIDARR_API_KEY=
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
      - "5432:5432"
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



### Option 3: Build from Source

```bash
git clone https://github.com/ofernander/nulmd.git
cd nulmd
docker compose up -d --build
```

## Upgrading from v4 to v5

v5 stores MusicBrainz data in MusicBrainz's own form, which is a new database layout. **A v4 database cannot be used by v5 directly.** If you start v5 against one, it stops with a message pointing here, and changes nothing.

You have two choices.

### Keep your data (recommended)

You'll copy your v4 database into a **new** database. The old one is only ever read, so you can go back at any time. Your cached images are untouched.

Before you start, make sure you're on the last 0.4.x release (start it once if you aren't; it updates its own schema).

1. **Stop nuLMD, but leave PostgreSQL running** (the converter needs a quiet database):

   ```bash
   docker compose stop nulmd-server
   ```

2. **Optional but sensible: take a backup.**

   ```bash
   docker exec nulmd-db pg_dump -U nulmd -Fc nulmd > nulmd-v4-backup.dump
   ```

3. **Pull the v5 image** (don't start it yet):

   ```bash
   docker compose pull nulmd-server
   ```

4. **Do a dry run.** It reads everything and writes nothing:

   ```bash
   docker compose run --rm nulmd-server node server/scripts/convert-v4.js --from nulmd --to nulmd_v5 --dry-run
   ```

5. **Convert.** `--from` is your current database name (`POSTGRES_DB` in your compose file); `--to` is a new name of your choice:

   ```bash
   docker compose run --rm nulmd-server node server/scripts/convert-v4.js --from nulmd --to nulmd_v5
   ```

   It creates the new database, copies your data, then checks the copy (row counts and a sample of rows read back) and tells you whether everything matched. Larger libraries take longer; it prints progress as it goes.

6. **Point nuLMD at the new database** by changing `POSTGRES_DB` in the `nulmd-server` section of your compose file:

   ```yaml
   - POSTGRES_DB=nulmd_v5
   ```

   Leave the `nulmd-db` section as it is.

   Apply it with `docker compose up -d` in the next step, not `docker compose start`: `start` restarts the existing container and ignores edits to the compose file.

7. **Start v5:**

   ```bash
   docker compose up -d
   ```

**If something looks wrong,** set `POSTGRES_DB` back to the old name and use your old v4 image. Nothing in the old database was changed. If a conversion stops partway, add `--force` to start over; it only ever wipes the *new* database, never the old one.

**What to expect after converting.** Your artists, albums, tracklists, links and images all come across, and Lidarr sees the same thing as before. v5 keeps more MusicBrainz detail than v4 did (areas, tag and genre counts, alias types, and more). Rows converted from v4 don't have that extra detail yet, so a few of those fields are empty until each artist or album is next refreshed from MusicBrainz, which happens when its TTL (Settings, Metadata Retention) expires. Lowering the TTL speeds that up, at the cost of more MusicBrainz requests.

If you only want to keep your image records (including images you uploaded yourself) and let the metadata fetch again, add `--images-only`.

### Start fresh

Change `POSTGRES_DB` to a new name and start v5. It creates the database and sets itself up. Your old database stays where it is.

### New in v5

- **MusicBrainz archive:** nuLMD keeps a copy of each MusicBrainz reply exactly as received, so your data can be rebuilt later without asking MusicBrainz again. It's a backup only, nothing is served from it, and it is always on. To rebuild from it: `node server/scripts/rebuild-from-archive.js`.
- **MusicBrainz API (`/ws/2`):** nuLMD can now answer other MusicBrainz clients, see [MusicBrainz API](#musicbrainz-api-ws2) below.
- **The Requests card** on the dashboard now shows who made each request (the tool's name and its IP address) and which API they used: `LMD` for the Lidarr metadata API, `MB` for the MusicBrainz API.
- **Blocklist.** Block an artist, release group or release and nuLMD removes what it holds for it and never fetches, stores or queues a job for it again. Block from the Metadata Browser, or by MusicBrainz ID in **Settings → Metadata Blocklist** (the only way to block a single release). Anything in Lidarr's library can't be blocked, and unblocking only lifts the ban: nothing is fetched until it is asked for again. The two *Various Artists* entries are always blocked.
- **A Controls menu** at the right of the tab bar holds the job and server actions: Clear Pending Jobs, Clear Pending Downloads and Kill Active Jobs; Trim Images Not in Lidarr and Trim Metadata Not in Lidarr; and Restart Server. Trim Metadata removes what is stored for artists that are no longer in Lidarr, and stops without deleting anything if Lidarr can't be reached or reports no artists.
- **Searches are kept for 24 hours** (`ws2.searchTtlHours`), both Lidarr's own search and searches through `/ws/2`, so asking again doesn't cost another MusicBrainz request. The same search typed with different spacing or capitals counts as the same one, and a search that found nothing is kept for only 15 minutes (`ws2.emptySearchTtlMinutes`). If your `config.yml` still has `searchTtlHours: 6` from an earlier install, change it: a saved value beats the default.
- **Fanart and the Lidarr integration have no on/off switch.** Each turns on when it has a key (Lidarr: a URL and a key), and a value set in the environment beats the one saved in the UI. Remove the key to turn it off; see [Environment Variables](#environment-variables-with-defaults). The raw archive and the idle MusicBrainz backfill have no settings either: they are always on.
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` now always take priority over `config.yml`. Before, they were only read the first time nuLMD ran.
- **A new artist is ready much sooner.** nuLMD now fetches an artist's whole catalog (every album, every release and every tracklist) in a handful of bulk MusicBrainz requests instead of hundreds of single ones. Lidarr is told as soon as the catalog is stored, and again once the overviews and covers are in. An artist that is past its TTL keeps being served from the stored copy while the new one is fetched in the background.
- **Lidarr may list more albums than before.** Every release is kept, whatever its status (before, only Official ones), because Lidarr chooses the release that matches your tracks. An album still won't appear if your Lidarr metadata profile doesn't allow its type (for example EP).
- **Fewer requests to MusicBrainz, Wikipedia and the image services.** Wikipedia lookups are sent in batches, Cover Art Archive is only asked about albums MusicBrainz says have artwork, and "looked, nothing there" is remembered (for as long as the metadata TTL) instead of being asked again at every refresh. A failed job now waits (15 seconds, growing to 5 minutes) before it is tried again. Cover Art Archive requests go out once a second; set `providers.coverartarchive.rateLimitMs` to change that.
- **If MusicBrainz is unreachable** and you have a [Lidarr metadata upstream](#lidarr-metadata-upstreams) configured, a new artist's catalog is taken from the upstream instead, marked *provisional*, and replaced by the checked MusicBrainz copy as soon as MusicBrainz answers. An artist whose catalog is already stored is never replaced by upstream data.
- **The dashboard shows the state of each catalog** under *Artists Cached* (checked, older, provisional, incomplete), and jobs waiting to be retried say when.
- `/ws/2` remembers a "not found" or "needs an account" answer from MusicBrainz for 10 minutes (`ws2.negativeTtlMinutes`, 0 turns it off), so a client asking again at once doesn't cost another request.
- Artists converted from v4 are shown as *older* until their TTL runs out; they then get the checked catalog.
- Removed, because they did nothing: the `CACHE_ENABLED`, `CACHE_TTL` and `CACHE_MAX_SIZE` environment variables (and the `/api/cache/*` endpoints), and the `metadata.fetchTypes` setting. They can stay in your compose file or `config.yml` without harm.

## Configuration

### Environment Variables with defaults
- SERVER_URL=http://localhost:5001
- PORT=5001
- LOG_LEVEL=info
- POSTGRES_HOST=nulmd-db
- POSTGRES_PORT=5432
- POSTGRES_DB=nulmd
- POSTGRES_USER=nulmd
- POSTGRES_PASSWORD=password
- LIDARR_URL=http://lidarr:8686
- LIDARR_API_KEY=
- MUSICBRAINZ_URL=
- MUSICBRAINZ_RATE_LIMIT=
- MUSICBRAINZ_SOURCES=
- LMD_UPSTREAMS=
- WS2_API_KEY=
- FANART_API_KEY=

The Lidarr integration is on when it has both a URL and an API key, and Fanart is on when it has a key. There is no switch: to turn one
off, remove its key (in the UI, then restart the server) or take the variable out of your compose file. A value set in the environment
always wins over the one saved in the UI, and the UI shows such a field as read-only.

## Image Caching

Enable CoverArtArchive and Fanart in the settings to have nuLMD cache images locally. Lidarr will first try to grab the images from nuLMD then
if not found will attempt to download from the source

### CoverArtArchive.org

Pulls album cover artwork from `https://coverartarchive.org`

### Deezer.com

Pulls artist and album cover art from `https://deezer.com`

### Fanart.tv

Pulls artist related artwork from `https://fanart.tv`

Add the key to `docker-compose.yml` or enter it in the UI (Fanart is on whenever it has a key)

```yaml
environment:
  - FANART_API_KEY=your_key_here
```

Get a key: `https://fanart.tv/get-an-api-key`

## Custom MusicBrainz Server

Enter URL of local MB host. Typically `http://localhost:5000`
Set rate limit to 0 for none

- MUSICBRAINZ_URL=
- MUSICBRAINZ_RATE_LIMIT=0

### Multiple MusicBrainz sources

Add several MusicBrainz servers and nuLMD spreads requests across them. Sources are grouped by priority
(lower number first); requests round-robin within a priority and spill to the next priority when a source
is busy or failing. Add them in the UI (Metadata Sources tab; changes apply immediately, no restart), or seed them from compose (shown there read-only, tagged "compose"):

- MUSICBRAINZ_SOURCES=http://mb1:5000/ws/2|1|0,http://mb2:5000/ws/2|1|0,https://musicbrainz.org/ws/2|2

Each entry is `url|priority|rateLimitMs` (priority and rate limit optional; rate limit 0 = none).

**Rate limits protect shared servers.** The three big public servers are fixed at one request every 2 seconds,
one at a time, and this can't be changed from the UI, `config.yml` or compose:

- the official MusicBrainz server (`musicbrainz.org`)
- the official Lidarr metadata server (`api.lidarr.audio`)
- the community brainzmash Lidarr metadata server (`lidarrapi.brainzmash.cc`)

They are matched by domain (any scheme, port, path or subdomain) and each can be listed only once. Any other
server that isn't on your own network defaults to the same 2 seconds, but you can change it, including lowering
it if the server's owner allows more. Servers on your own network (localhost, private IPs, bare container names
like `mb`, `.local`/`.lan`/`.internal`) have no default limit.

### Lidarr metadata upstreams

You can also add a Lidarr metadata server (the official `api.lidarr.audio` or a self-hosted LMD) as a source.
An upstream returns a whole artist or album in one request, so it is much faster than assembling the same data
from many MusicBrainz calls. It sits in the same priority/round-robin pool as the MusicBrainz sources. Nothing
is configured by default.

- LMD_UPSTREAMS=https://api.lidarr.audio/api/v0.4|2

Same `url|priority|rateLimitMs` format (the rate limit is fixed for the public servers above, otherwise it defaults to 2000ms for remote servers and 1000ms for ones on your network). MusicBrainz always stays in the pool: it
serves anything an upstream can't (artist-filtered album search, individual releases the upstream hasn't
returned) and it is the authority. Rows filled from an upstream are marked `needs_mb_backfill` and are
never allowed to blank data that MusicBrainz already provided (country, dates, tags, barcodes...).

When nuLMD has been idle (no Lidarr requests for 30s, nothing queued, no source busy), a low-priority backfill job
re-fetches flagged artists and albums from MusicBrainz itself and fills the gaps. Backfill never uses an upstream.
It is always on; there is nothing to configure.

## MusicBrainz API (/ws/2)

nuLMD also speaks MusicBrainz's own web service, so any tool that talks to musicbrainz.org can talk to your nuLMD instead: Picard, beets, scripts using `musicbrainzngs`, and so on. It is on by default, next to the Lidarr API, at:

```
http://<your-nulmd-host>:5001/ws/2
```

Answers are XML, as on musicbrainz.org, or JSON with `fmt=json` (or an `Accept: application/json` header).

### What it answers, and from where

| Request | Answered from |
|---|---|
| Lookup of an artist, release group, release or recording, with the includes nuLMD keeps (aliases, tags, genres, ratings, URL relationships, labels, tracklists, ISRCs, artist credits) | nuLMD's own data. The first ask fetches it from MusicBrainz once; after that it costs no MusicBrainz request. |
| The same, with anything else (works, other relationships, an artist's full list of release groups, ...) | MusicBrainz, exactly as it sent it. The reply is kept for 24 hours. |
| Browse: the release groups of an artist, the releases of a release group | MusicBrainz for the first ask, while nuLMD fetches the whole list in the background when it is idle. After that, nuLMD answers it, including the `type` and `status` filters, with MusicBrainz's own counts. |
| Search, and lookups of things nuLMD does not store (labels, works, areas, series, events, places, instruments, URLs, ISRCs, ISWCs, disc IDs) | MusicBrainz, exactly as it sent it. Kept for 24 hours (a search that found nothing, 15 minutes). The same search typed with different spacing or capitals is one entry. |

Notes:

- Lists nuLMD serves come back earliest first. MusicBrainz's own order changes with the page size, so there is no single order to copy.
- The `X-nuLMD-Served` header on browse, search and passed-through answers says which path answered: `list`, `proxy` (just fetched from MusicBrainz) or `proxy-cached`.
- nuLMD asks MusicBrainz at the same polite rate as everything else (see [Custom MusicBrainz Server](#custom-musicbrainz-server)). A busy MusicBrainz is retried briefly; if it stays busy the client gets a `503` with `Retry-After`.

### API keys

Until you make a key, anyone who can reach nuLMD can use `/ws/2`. After the first key, every request must carry one.

In **Settings, MusicBrainz API**, type a name (one per app or person works well, for example "Picard laptop") and press **Generate Key**. The key is shown once and nuLMD keeps only a hash of it, so copy it then. You can make as many as you like and remove any of them at any time; a removed key stops working immediately. The list shows when each was made, when it was last used and how many requests it has made.

Clients send the key in any one of three ways:

```
X-API-Key: nulmd_...
Authorization: Bearer nulmd_...
http://<host>:5001/ws/2/artist/<mbid>?apikey=nulmd_...
```

`WS2_API_KEY` in your compose file still works too, as one more key (listed read-only in Settings).

Keys only apply to `/ws/2`. The Lidarr API is not affected.

Some MusicBrainz libraries, `musicbrainzngs` among them, cannot send a header or add a URL parameter, so tools built on them cannot use a key-protected nuLMD. For those, leave `/ws/2` open on a network you trust.

### Using it

For `musicbrainzngs` (plain http, no key):

```python
import musicbrainzngs as mb

mb.set_hostname("nulmd-server:5001")     # your nuLMD host and port
mb.set_useragent("my-app", "1.0")

mb.get_artist_by_id("a74b1b7f-71a5-4011-9441-d0b5e4122711", includes=["aliases", "tags"])
mb.search_artists("radiohead", limit=3)
```

On the dashboard, the **Requests** card shows each request with who made it and which API they used, so you can see an app's traffic next to Lidarr's.

## Lidarr Setup

You need the nightly Lidarr image from lscr.io/linuxserver/lidarr:nightly which has plugins enabled

Install the Tubifarry plugin https://github.com/TypNull/Tubifarry

Settings → Metadata Sources → Custom

URL stand alone - `http://localhost:5001`
URL with stack - `http://nulmd-server:5001`

