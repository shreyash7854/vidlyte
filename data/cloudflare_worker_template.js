/**
 * VidLyte Cloudflare Edge Proxy Worker Template
 * =============================================================================
 * Sovereign HLS Segment & Manifest Stream Proxy with Dynamic Referer Spoofing,
 * Byte-Range Forwarding, and Sub-Millisecond Edge Delivery.
 *
 * Deployment (Free Tier):
 * 1. Log in to Cloudflare Dashboard -> Workers & Pages -> Create Application
 * 2. Paste this code into the Worker editor
 * 3. Save & Deploy (e.g. https://vidlyte-proxy-node1.<account>.workers.dev)
 * 4. Add the URL to VidLyte Admin Swarm:
 *    https://vidlyte-proxy-node1.<account>.workers.dev/proxy?url=
 * =============================================================================
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Health Probe Endpoint for Swarm Balancer Latency Probes
    if (url.pathname === "/health" || url.pathname === "/ping" || (!url.searchParams.get("url") && (url.pathname === "/" || url.pathname === "/proxy"))) {
      return new Response(JSON.stringify({
        status: "healthy",
        service: "vidlyte-edge-proxy",
        timestamp: Date.now(),
        colo: request.cf ? request.cf.colo : "EDGE"
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, no-store"
        }
      });
    }

    // 2. Handle CORS Preflight Requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Accept, Accept-Encoding, Referer, User-Agent, X-Requested-With",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // 3. Extract and Validate Target URL
    const rawTarget = url.searchParams.get("url");
    if (!rawTarget) {
      return new Response("VidLyte Edge Proxy: Missing target 'url' parameter.", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawTarget);
    } catch (e) {
      return new Response("VidLyte Edge Proxy: Invalid target URL supplied.", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // 4. Spoof Upstream Security Headers based on Provider
    const provider = url.searchParams.get("provider") || "orion";
    let origin = "https://embed.vidrift.net";
    let referer = "https://embed.vidrift.net/";

    if (provider === "asianflix" || provider === "rumble") {
      origin = "https://asianflix.one";
      referer = "https://asianflix.one/";
    } else if (provider === "framex") {
      origin = "https://api.framextv.xyz";
      referer = "https://api.framextv.xyz/";
    }

    // Clone incoming headers and inject required bypass headers
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set("Origin", origin);
    reqHeaders.set("Referer", referer);
    reqHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    reqHeaders.delete("CF-Connecting-IP");
    reqHeaders.delete("X-Forwarded-For");

    // Pass Range header for chunk seeking
    const rangeHeader = request.headers.get("Range");
    if (rangeHeader) {
      reqHeaders.set("Range", rangeHeader);
    }

    // 5. Fetch Stream / Manifest from Upstream CDN
    try {
      const upstreamResp = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow"
      });

      // Prepare response headers with full CORS and cache headers
      const resHeaders = new Headers(upstreamResp.headers);
      resHeaders.set("Access-Control-Allow-Origin": "*");
      resHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      resHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");

      // Set sensible caching for immutable media chunks
      if (targetUrl.pathname.endsWith(".ts") || targetUrl.pathname.endsWith(".m4s")) {
        resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (targetUrl.pathname.endsWith(".m3u8")) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: resHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: "VidLyte Edge Node: Upstream fetch failed",
        details: err.message
      }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
