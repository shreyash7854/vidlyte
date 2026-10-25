# VidLyte — Sovereign HLS Streaming Gateway & Universal Player

VidLyte is a high-performance, zero-external-dependency HLS streaming redistribution gateway, media resolver, and modern embed player built with Go 1.22+ and vanilla web technologies.

---

## Documentation Index

Comprehensive engineering documents are located in the [`docs/`](file:///d:/@1/byse-norm/docs/) directory:

- [**System Architecture**](file:///d:/@1/byse-norm/docs/ARCHITECTURE.md) — Dual-listener topology, router, dynamic configuration hot-reloading, and proxy swarm.
- [**Security & 100% M3U8 Tokenization**](file:///d:/@1/byse-norm/docs/SECURITY_AND_M3U8.md) — HMAC-SHA256 token verification, sliding expirations, recursive chunk signing, sandbox shields, and SSRF prevention.
- [**Monetization & Anti-Adblock Engine**](file:///d:/@1/byse-norm/docs/MONETIZATION_AND_ANTI_ADBLOCK.md) — Multi-vector detection (Brave native API, cosmetic bait, network canary), Adsterra popunders, and enforcement shields.
- [**Deployment & Environment Setup**](file:///d:/@1/byse-norm/docs/DEPLOYMENT_AND_ENV.md) — Cloud deployment guides (Render, Koyeb, Railway, VPS, Docker), `.env` reference, and GitHub commit guide.
- [**API & Embed Reference**](file:///d:/@1/byse-norm/docs/API_AND_EMBED.md) — Embed URLs, query parameters, REST APIs, and health check endpoints.

---

## Quickstart

```bash
# Run test suite
go test ./...

# Build standalone binary
go build -o resolver.exe .

# Launch VidLyte Core Hub
./resolver.exe
```

- Public Portal: `http://localhost:8080/`
- Secret Mission Control: `http://localhost:8080/admin-login-i`
- Player Edge: `http://localhost:6789/` or `http://localhost:8080/embed/tv/289423/1/1`
