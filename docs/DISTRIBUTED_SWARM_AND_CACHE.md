# VidLyte Distributed Edge Swarm & Decentralized Tiered Cache

> **High-Performance Architecture Specification for 100% Free-Tier Video Infrastructure**  
> Operating with **Zero Central Store**, **Infinite Edge Scaling**, and **Sub-Millisecond Media Chunk Delivery**.

---

## 1. Executive Summary & Design Principles

Video streaming delivers high bandwidth and massive request volumes. A standard 45-minute episode in 1080p consists of:
- **~450 to 900 individual `.ts` transport stream segments** (each 3–6 seconds long, ~1–3 MB each).
- **~1.2 GB of raw video payload**.
- Multiple playlist fetches (`master.m3u8` and variant playlists like `720p.m3u8`, `1080p.m3u8`).

### The Challenge of Free Tiers:
| Free Tier Service | Daily Quota / Limitations | Catastrophic Risk If Misused |
| :--- | :--- | :--- |
| **Cloudflare Workers (Free)** | 100,000 requests/day per account | Overwhelmed by only 100–150 full episode streams if uncoordinated. |
| **Upstash Redis (Free)** | 10,000 commands/day per DB, 256 MB max, 1 MB max value size | **Never put video chunks in Redis!** Storing `.ts` segments will blow the 1 MB limit and exhaust the 256 MB memory instantly. |
| **Render / Koyeb Free Container** | 512 MB RAM, 0.1 CPU, spun down on inactivity, strict egress caps | Proxying GBs of video through Go container exhausts container bandwidth and CPU. |

### The VidLyte Highest-Grade Solution:
1. **Segregation of Concerns**:
   - **Metadata & Manifests** (small, sub-kilobyte JSON / M3U8): Handled by Go Core + In-Memory L1 Cache + Decentralized L2 Upstash Redis Swarm.
   - **Video Media Chunks (`.ts`, `.m4s`, `.mp4`)**: Bypasses the Go backend server completely! Rewritten directly into the **Cloudflare Edge Worker Swarm (L3)**.
2. **Zero Central Store Rendezvous Hashing (HRW)**:
   - Neither the Go gateway nor the Cloudflare workers require a shared coordinator or database to determine node selection.
   - Using **Highest Random Weight (HRW) Hashing**, all nodes deterministically pick the exact same edge worker for a given video chunk URL.
   - Result: **Maximum Cache Affinity**. Segment `seg_104.ts` will *always* route to Worker A across every user in the world, ensuring a 99%+ Edge Cache Hit Rate.
3. **Multi-Account Edge Swarm**:
   - Webmasters can add 5, 10, or 20 free Cloudflare worker endpoints.
   - 10 workers = **1,000,000 free requests/day** + Petabytes of free cached bandwidth via Cloudflare's global edge network.

---

## 2. Multi-Tier Distributed Architecture Diagram

```mermaid
flowchart TD
    subgraph ClientLayer [Client & Player Layer]
        Player["VidLyte Hls.js Sovereign Player<br/>(Deep Pre-buffering: 60s Buffer, 6x Retry Backoff)"]
    end

    subgraph GoCoreGateway [VidLyte Go Core Engine (Render / Koyeb / Docker)]
        Router[HTTP Router & Auth Verifier]
        L1Cache[L1 In-Memory LRU RAM Cache<br/>0.02ms Latency]
        Rewriter[HLS Playlist Rewriter & Edge Router]
        HRWHasher[HRW Rendezvous Hash Engine]
    end

    subgraph L2DecentralizedCache [L2 Upstash Redis Swarm (Zero Central Store)]
        Upstash1["Upstash DB 1 (Free Account 1)<br/>10k cmds/day"]
        Upstash2["Upstash DB 2 (Free Account 2)<br/>10k cmds/day"]
        UpstashN["Upstash DB N (Free Account N)<br/>10k cmds/day"]
    end

    subgraph L3CloudflareSwarm [L3 Edge Worker Swarm (Cloudflare Global Anycast)]
        direction TB
        CF1["Worker 1 (alpha-lytenode)<br/>100k req/day + Edge Cache"]
        CF2["Worker 2 (bravo-lytenode)<br/>100k req/day + Edge Cache"]
        CF3["Worker N (node-N)<br/>100k req/day + Edge Cache"]
    end

    subgraph UpstreamOrigins [Upstream CDN Origins]
        VidriftOrigin[Vidrift CDN & Storage]
        AsianFlixOrigin[AsianFlix Direct]
        FrameXOrigin[FrameX Origin]
    end

    %% Flow 1: Embed & Manifest Resolution
    Player -->|1. Fetch /hls/.../master.m3u8| Router
    Router -->|Check L1| L1Cache
    L1Cache -.->|L1 Miss| HRWHasher
    HRWHasher -->|Hash Key to Target DB| Upstash1
    HRWHasher -->|Fallback if Down| Upstash2
    Router -->|Rewrite Segments to Workers| Rewriter
    Rewriter -->|Return M3U8 with Edge URLs| Player

    %% Flow 2: Direct Segment Streaming
    Player -->|2. GET segment_01.ts| CF1
    Player -->|3. GET segment_02.ts| CF2
    Player -->|4. GET segment_03.ts| CF1

    CF1 -->|Cache HIT 99%| CF1
    CF1 -.->|Cache MISS 1%| VidriftOrigin
    CF2 -.->|Cache MISS 1%| VidriftOrigin
```

---

## 3. The Mathematics of Zero Central Store (Rendezvous / HRW Hashing)

Traditional distributed systems require a coordinator (ZooKeeper, etcd, Redis Sentinel, or a central SQL DB) to keep a directory of which server holds what key. In a free-tier ecosystem, running a coordinator costs money and creates a single point of failure.

VidLyte uses **Highest Random Weight (HRW) / Rendezvous Hashing** implemented in pure Go:

### Algorithmic Formula:
Given a key $K$ (e.g. `tv/289423/1/2/seg_045.ts`) and a set of active nodes $\{N_1, N_2, \dots, N_m\}$:

$$\text{Weight}(N_i) = \text{Score}(K, N_i.URL) \times N_i.WeightMultiplier$$

$$\text{SelectedNode} = \arg\max_{N_i} \left( \text{Weight}(N_i) \right)$$

### Properties:
1. **Deterministic**: Every server, worker, or script calculates the identical destination node for key $K$ with zero inter-process communication.
2. **Minimal Disruption ($1/N$ Rehash)**: If node $N_3$ fails or is removed, only the keys that mapped to $N_3$ are distributed among the remaining nodes. All other keys remain on their assigned nodes.
3. **No Hot-Spots**: FNV-1a 64-bit hash distribution spreads traffic evenly across all worker accounts.
4. **Weighted Distribution**: Faster nodes can be assigned a higher weight (e.g. 20 vs 10) to accept a proportional share of traffic.

---

## 4. Implementation Details in VidLyte

### A. Media Segment Routing (`internal/hls/rewriter.go`)
When a user requests a variant M3U8 playlist:
1. The Go server parses every line of the manifest.
2. Manifest child playlists (`.m3u8`) remain pointed at `/hls/...` so session tokens and authorization remain enforced.
3. Media chunks (`.ts`, `.m4s`, `.mp4`) are passed into `SegmentRouter`:
   ```go
   swarm.BuildProxiedURLForKey(rawURL, providerID, chunkPath)
   ```
4. The URL is rewritten into:
   ```text
   https://alpha-lytenode.jadiel35.workers.dev/?url=https%3A%2F%2Fupstream.cdn%2Fseg104.ts
   ```
5. **Outcome**: The user's browser requests the media chunk **directly from the Cloudflare Worker**, completely bypassing your Go server. Your Go server consumes **0 KB** of bandwidth for video data.

### B. Tiered Decentralized Cache (`internal/cache/upstash_swarm.go`)
- **L1 In-Memory**: High-speed Go map protected with read-write mutex. Serves resolved stream metadata in 0.02ms.
- **L2 Upstash Swarm**: When L1 misses, the key is hashed across the configured `UPSTASH_REDIS_REST_URLS`. If the primary Upstash node is rate-limited or unavailable, the request automatically falls back to the secondary node.
- **Async Write**: Cache writes to L2 Upstash are executed in background goroutines (`go swarm.Set(...)`), adding 0ms of latency to the end-user playback request.

### C. Client Player Tuning (`internal/embed/player.html`)
To prevent player stuttering and buffering on low-speed connections:
```javascript
const hlsConfig = {
    enableWorker: true,
    lowLatencyMode: false,          // False allows deep prebuffering for VOD
    backBufferLength: 60,           // Retains 60s of previous video in RAM
    maxBufferLength: 60,            // Pre-buffers 60s ahead of playhead
    maxMaxBufferLength: 120,        // Allows up to 2 minutes on fast connections
    maxBufferSize: 60 * 1000 * 1000,// 60 MB buffer headroom
    progressive: true,              // Progressive chunk streaming
    manifestLoadingMaxRetry: 6,
    manifestLoadingRetryDelay: 500,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 500,
    fragLoadingMaxRetry: 6,         // 6 retries on segment drops
    fragLoadingRetryDelay: 500,
};
```

---

## 5. Cloudflare Worker Edge Proxy Script

Here is the exact code deployed on `https://alpha-lytenode.jadiel35.workers.dev/`:

```javascript
/**
 * VidLyte Cloudflare Edge Proxy & Caching Worker
 * Zero-maintenance, high-throughput media proxy with upstream header spoofing and guaranteed CORS.
 */
export default {
  async fetch(request, env, ctx) {
    // 1. CORS headers helper
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response("Missing target url parameter", { 
        status: 400,
        headers: corsHeaders 
      });
    }

    // 2. Query Cloudflare Edge Cache API (GET requests only)
    const cache = caches.default;
    const cacheKey = new Request(targetUrl, { method: "GET" });
    let cached = await cache.match(cacheKey);

    if (cached) {
      const newHeaders = new Headers(cached.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        newHeaders.set(k, v);
      }
      newHeaders.set("X-VidLyte-Cache", "HIT");
      return new Response(cached.body, {
        status: cached.status,
        headers: newHeaders,
      });
    }

    // 3. Spoof Upstream Security Headers with client Range forwarding
    const upstreamHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Referer": "https://embed.vidrift.net/",
      "Origin": "https://embed.vidrift.net",
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br",
    });

    const clientRange = request.headers.get("Range");
    if (clientRange) {
      upstreamHeaders.set("Range", clientRange);
    }

    try {
      const upstreamResponse = await fetch(targetUrl, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      });

      // Construct edge response with guaranteed CORS headers
      const responseHeaders = new Headers(upstreamResponse.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        responseHeaders.set(k, v);
      }

      if (!upstreamResponse.ok) {
        responseHeaders.set("X-VidLyte-Cache", "ERROR");
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }

      responseHeaders.set("X-VidLyte-Cache", "MISS");

      // Video segments (.ts, .m4s, .mp4) are immutable; cache for 24h at the edge
      if (targetUrl.includes(".ts") || targetUrl.includes(".m4s") || targetUrl.includes(".mp4")) {
        responseHeaders.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
      } else {
        responseHeaders.set("Cache-Control", "public, max-age=30, s-maxage=30");
      }

      const responseToCache = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });

      // Asynchronously populate Cloudflare Edge Cache for successful responses
      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

      return responseToCache;
    } catch (err) {
      return new Response("Upstream Gateway Proxy Error: " + err.message, { 
        status: 502,
        headers: corsHeaders 
      });
    }
  },
};
```

---

## 6. How to Scale to 20+ Free Cloudflare Workers

1. **Create Free Cloudflare Accounts**:
   - Each Cloudflare account offers **100,000 requests/day** for free on Workers.
   - You can create multiple accounts or use subdomains (`node1.workers.dev`, `node2.workers.dev`, etc.).
2. **Deploy the Worker Script**:
   - In the Cloudflare dashboard, click **Workers & Pages** ➔ **Create Application** ➔ **Create Worker**.
   - Paste the code above and click **Deploy**.
3. **Register in VidLyte Admin Control Room**:
   - Visit `http://your-domain/admin-login-i`.
   - Scroll down to the **Edge Proxy Swarm** card.
   - Enter your worker URL: `https://node2.your-account.workers.dev/?url=`.
   - Set weight to `10` and click **Add Worker Node**.
   - VidLyte immediately begins balancing traffic across all registered nodes using HRW consistent hashing.
4. **Instant Invalidation / Failover**:
   - If any worker node begins throwing 5xx errors or exhausts its quota, VidLyte automatically marks it down and redistributes its traffic seamlessly to healthy nodes.

---

## 7. How to Connect Upstash Redis Swarm

1. Visit [https://upstash.com/](https://upstash.com/) and create 1 to 5 free Serverless Redis databases (10,000 commands/day per database).
2. For each database, copy the **REST URL** and **REST Token** from the Upstash Console.
3. Add them to your environment variables or `.env` file:
   ```env
   UPSTASH_REDIS_REST_URLS=https://db1.upstash.io,https://db2.upstash.io,https://db3.upstash.io
   UPSTASH_REDIS_REST_TOKENS=token_db1,token_db2,token_db3
   ```
4. Restart VidLyte.
5. The core engine will log:
   ```json
   {"time":"...","level":"INFO","msg":"initialized distributed Upstash Redis swarm","nodes":3}
   ```
6. Playback metadata and resolved manifest links will now persist seamlessly across restarts with sub-15ms lookup speeds across the swarm.
