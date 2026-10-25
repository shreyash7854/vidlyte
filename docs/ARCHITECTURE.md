# VidLyte System Architecture

VidLyte is a zero-external-dependency, high-throughput HLS streaming gateway, media resolver, and modern embed player designed for webmasters and streaming networks. Built with Go 1.22+ and vanilla web technologies, the entire system operates with microsecond-level overhead, sub-millisecond route dispatch, and zero third-party package dependencies.

---

## 1. High-Level Architectural Overview

VidLyte employs a decoupled multi-listener topology that separates the public webmaster portal and administrative command hub from the public-facing video player edge.

```mermaid
flowchart TD
    subgraph ClientLayer [Client & Webmaster Layer]
        UserBrowser[End-User Device / Mobile Browser]
        WebmasterSite[Webmaster Streaming Site]
        AdminBrowser[Authorized Administrator]
    end

    subgraph EdgeLayer [DNS & CDN Edge]
        CloudflareEdge[Cloudflare CDN & Proxy]
        CFWorkerSwarm[Cloudflare Worker Proxy Swarm]
    end

    subgraph VidLyteCore [VidLyte Core Go Engine]
        direction TB
        subgraph Ports [Dual Listener Engine]
            HubListener["Hub Listener (:8080)<br/>• Portal & Embed Builder<br/>• /admin-login-i<br/>• Gateway & Resolver API"]
            PlayerListener["Edge Player Listener (:6789)<br/>• /embed/movie/:id<br/>• /embed/tv/:id/:s/:e<br/>• /api/proxy (Signed HLS)"]
        end

        subgraph Modules [Core Subsystems]
            Router[Go 1.22+ HTTP ServeMux]
            MiddlewareChain[Recovery ➔ Logger ➔ CORS ➔ Gzip]
            DynamicConfig[Dynamic JSON Config Store<br/>vidlyte_config.json]
            AdminAuth[HMAC Session & Brute-Force Guard]
            ResolverSvc[Upstream Multi-Source Resolver]
            StreamSigner[HMAC-SHA256 Token Engine]
            SSRFGuard[Upstream SSRF & Header Injector]
            DiskCacheEngine[Optional High-Speed Chunk Cache]
        end
    end

    subgraph UpstreamProviders [Third-Party Streaming Sources]
        Vidrift[Vidrift API & CDN]
        AsianFlix[AsianFlix Direct]
        Orion[Orion Media Edge]
        TMDB[TheMovieDatabase Meta API]
    end

    AdminBrowser -->|HTTPS /admin-login-i| HubListener
    WebmasterSite -->|Embeds IFRAME| PlayerListener
    UserBrowser -->|Plays Video Stream| PlayerListener

    HubListener --> MiddlewareChain
    PlayerListener --> MiddlewareChain
    MiddlewareChain --> Router

    Router --> AdminAuth
    Router --> ResolverSvc
    Router --> StreamSigner
    Router --> SSRFGuard

    DynamicConfig -.->|Hot Reload / Zero Downtime| Modules

    SSRFGuard -->|Direct Fetch| Vidrift
    SSRFGuard -->|Direct Fetch| AsianFlix
    SSRFGuard -->|Direct Fetch| Orion
    SSRFGuard -->|Distributed Tunnel| CFWorkerSwarm
    CFWorkerSwarm -->|Fetch Upstream Chunks| UpstreamProviders
```

---

## 2. Core Architectural Pillars

### A. Zero-Dependency Go Standard Library Standard
VidLyte uses purely Go standard library packages (`net/http`, `crypto/hmac`, `crypto/sha256`, `encoding/json`, `sync`, `time`, `os`). This ensures:
- **Zero Supply-Chain Risk**: Immune to malicious upstream npm/Go module vulnerabilities.
- **Microsecond Cold-Starts**: Single binary footprint under 14 MB that boots instantaneously on bare-metal, Docker, Render, or Koyeb.
- **Ultra-Low Memory Footprint**: Operates comfortably in resource-constrained environments (128 MB RAM).

### B. Dual-Listener Decoupled Topology
1. **Master Core Hub (`:8080`)**:
   - Hosts the VidLyte Webmaster Portal (`/`) and dynamic live player sandbox.
   - Hosts the hidden administrative control center (`/admin-login-i`).
   - Hosts the REST API and HLS session gateway (`/v1/playback-sessions`, `/hls/...`).
2. **Edge Player Listener (`:6789`)**:
   - Dedicated exclusively to serving iframe players (`/embed/...`) and streaming proxied video chunks (`/api/proxy`).
   - Can be bound to distinct public domain names or isolated edge servers, ensuring traffic spikes on the player do not impact administration or source resolution.
   - Can run unified on a single port (`PORT=8080`, `PLAYER_PORT=none`) for single-port cloud hosts like Render and Koyeb.

### C. Zero-Downtime Dynamic Configuration (`vidlyte_config.json`)
Operational parameters can be tuned in real time via the Admin Control Room without restarting the server:
- Brand styling, logos, and accent colors.
- Server display names and priority ordering (Orion, Vela, Atlas, Titan, Lyra).
- Cloudflare Worker proxy swarm endpoints with live latency testing.
- Adsterra popunder monetization keys, frequencies, and target domains.
- Anti-Adblock detection enforcement policies and custom visitor prompts.

The configuration store uses atomic file writes (`sync.RWMutex` + atomic rename) to guarantee zero corruption and zero race conditions under high concurrent read traffic.

---

## 3. Request Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as Mobile / Desktop User
    participant Embed as /embed/tv/:id/:s/:e
    participant Resolver as Resolver Service
    participant Admin as Config Store
    participant Proxy as Stream Proxy (/api/proxy)
    participant Upstream as Upstream CDN

    User->>Embed: Loads player iframe
    Embed->>Admin: Read active branding & monetization rules
    Embed->>Resolver: Resolve video sources (Orion, Vela, AsianFlix)
    Resolver-->>Embed: Upstream Master M3U8 URL
    Embed->>Proxy: Sign URL with HMAC-SHA256 (sig + exp)
    Embed-->>User: Returns Sovereign Player HTML with Signed Stream URL

    Note over User,Embed: User taps Play Button
    User->>Proxy: GET /api/proxy?url=...&exp=...&sig=...
    Proxy->>Proxy: Verify HMAC-SHA256 & Expiration
    alt Signature Invalid or Expired
        Proxy-->>User: 403 Forbidden (Tamper Proof)
    else Signature Valid
        Proxy->>Upstream: Forward request with spoofed Referer & Headers
        Upstream-->>Proxy: Returns raw M3U8 manifest
        Proxy->>Proxy: Recursively rewrite all child URLs with signed proxy tokens
        Proxy-->>User: Return rewritten M3U8 to user player
    end

    User->>Proxy: GET /api/proxy?url=segment01.ts&exp=...&sig=...
    Proxy->>Upstream: Stream TS segment
    Upstream-->>User: Binary TS Video Data
```

---

## 4. Subsystem Breakdown

| Subsystem | Location | Functionality |
| :--- | :--- | :--- |
| **Admin Operations** | [`internal/admin/`](file:///d:/@1/byse-norm/internal/admin/) | Secret authentication, lockout protection, proxy swarm health checks, dynamic config API. |
| **Dynamic Config** | [`internal/config/`](file:///d:/@1/byse-norm/internal/config/) | File-backed JSON store with thread-safe atomic memory synchronization. |
| **Embed Player** | [`internal/embed/`](file:///d:/@1/byse-norm/internal/embed/) | Glassmorphic video player UI, mobile bottom sheet, Web Audio API booster, anti-adblock detection engine. |
| **HLS Stream Proxy** | [`internal/proxy/`](file:///d:/@1/byse-norm/internal/proxy/) | HMAC-SHA256 stream token verification, recursive manifest rewriting, and worker load balancing. |
| **Multi-Source Resolver**| [`internal/service/`](file:///d:/@1/byse-norm/internal/service/) | Multi-tier source resolution (Vidrift, AsianFlix, FrameX) with automatic fallback. |
| **Gateway & Cache** | [`internal/gateway/`](file:///d:/@1/byse-norm/internal/gateway/) | Session-based HLS distributor with LRU memory and disk chunk caching. |
| **Distributed Swarm & Cache** | [`docs/DISTRIBUTED_SWARM_AND_CACHE.md`](file:///d:/@1/byse-norm/docs/DISTRIBUTED_SWARM_AND_CACHE.md) | Decentralized L1 RAM + L2 Upstash Redis Swarm + L3 Cloudflare Edge Worker CDN Swarm. |
| **Public Portal** | [`internal/portal/`](file:///d:/@1/byse-norm/internal/portal/) | Webmaster homepage, embed code generator, live preview builder, documentation. |
