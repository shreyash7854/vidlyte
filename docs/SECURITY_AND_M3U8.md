# VidLyte Security & M3U8 Tokenization Guide

VidLyte implements a multi-layered security model designed to solve the critical vulnerabilities commonly exploited against third-party streaming sites: manifest scraping, hotlinking, bandwidth leeching, iframe sandboxing, and unauthorized administrative access.

---

## 1. 100% Cryptographic M3U8 Tokenization

### The Scraping Vulnerability
In standard streaming setups, an attacker inspects Network tab requests, copies the master `.m3u8` link, and re-embeds it into their own player or app without displaying your advertisements. This steals bandwidth while generating zero ad revenue.

### VidLyte Cryptographic Solution
VidLyte terminates direct access to upstream stream URLs. Every internal stream URL served by VidLyte is signed using an **HMAC-SHA256 digital signature**:

```
/api/proxy?url=<ENCODED_TARGET>&exp=<UNIX_TIMESTAMP>&sig=<HMAC_SHA256_HEX>
```

#### Signature Generation
The signature is generated using a server-side secret (`STREAM_SECRET`):
$$\text{Signature} = \text{HMAC-SHA256}(\text{Secret}, \text{TargetURL} \parallel \text{"|"} \parallel \text{Expiration})$$

```go
// internal/proxy/token.go
func GenerateStreamToken(targetURL string, exp time.Time) string {
    mac := hmac.New(sha256.New, getSecretKey())
    payload := fmt.Sprintf("%s|%d", targetURL, exp.Unix())
    mac.Write([]byte(payload))
    return hex.EncodeToString(mac.Sum(nil))
}
```

#### Sliding Expiration Windows
- Each URL has a hard expiration timestamp (`exp`), typically set to 4 hours.
- If an attacker copies the URL, the link becomes permanently invalid once `exp < time.Now().Unix()`.
- Modifying `exp` invalidates the HMAC signature, causing the gateway to reject the request immediately with `403 Forbidden`.

#### Recursive Manifest & Chunk Rewriting
When the player requests a master playlist, VidLyte intercepts the upstream response and dynamically rewrites every URI:
1. Sub-variant playlists (`1080p.m3u8`, `720p.m3u8`, `480p.m3u8`).
2. Audio track playlists (`audio-eng.m3u8`, `audio-hin.m3u8`).
3. Subtitle track playlists (`subs-en.vtt`).
4. Media chunks (`segment001.ts`, `segment001.m4s`, `init.mp4`).

Every single segment URL is rewritten through `SignProxyURL()`, guaranteeing that even individual media chunks cannot be leeched directly from the upstream CDN.

---

## 2. Upstream SSRF Firewall & Header Spoofing

### SSRF Prevention
Upstream requests are strictly validated against an approved hostname whitelist (`GATEWAY_UPSTREAM_HOSTS`). Any attempt to proxy private IP addresses (`10.0.0.0/8`, `192.168.0.0/16`, `169.254.169.254` AWS metadata) or unapproved domains is rejected before a network socket is created.

### Intelligent Header Spoofing
Upstream CDNs (such as Vidrift, AsianFlix, and Cloudflare-protected edges) inspect HTTP headers to block third-party players. VidLyte's reverse proxy automatically reconstructs legitimate request headers:

- **Referer Matching**: Replaced with the expected upstream domain (`https://vidrift.net/`, `https://asianflix.one/`).
- **Origin Spoofing**: Matches the target CDN origin.
- **Header Sanitization**: Removes `X-Forwarded-For`, `CF-Connecting-IP`, and proxy footprints so upstream CDNs see standard browser client traffic.
- **Range Support**: Pass-through support for `bytes=x-y` range headers, enabling instant video seeking.

---

## 3. Player Sandbox & Anti-Bypass Shield

### The Sandbox Bypass Attack
Some scrapers or rogue webmasters embed video players inside an `<iframe>` configured with restrictive `sandbox` attributes:
```html
<!-- Malicious bypass attempt -->
<iframe src="https://your-player.com/embed/movie/550" sandbox="allow-scripts"></iframe>
```
By intentionally omitting `allow-popups` or `allow-same-origin`, the malicious webmaster prevents your popunder advertisements from firing while still playing your video stream for free.

### VidLyte Sandbox Shield
The player contains active client-side sandbox detection:
```javascript
function detectSandbox() {
    try {
        // Test popup capability
        var testWin = window.open('about:blank', '_blank', 'width=1,height=1');
        if (!testWin) {
            // Popup blocked by sandbox attribute
            triggerSandboxBlock();
            return;
        }
        testWin.close();
    } catch(e) {
        triggerSandboxBlock();
    }
}
```

If restrictive sandboxing is detected:
1. Video playback is paused and disabled.
2. A full-screen security shield is mounted:
   > **Embed Notice**: VidLyte cannot be embedded with restrictive sandbox rules. Ensure your iframe includes:
   > `sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"`
3. The video stream will not decrypt or buffer until unrestricted playback is permitted.

---

## 4. Admin Authentication & Brute-Force Mitigation

The VidLyte administrative mission control is hosted at `/admin-login-i`. It is protected by military-grade authentication:

1. **Obfuscated Endpoint**: Not discoverable through standard routes or site navigation.
2. **Timing-Safe Secret Verification**: Uses `crypto/subtle.ConstantTimeCompare` to defend against side-channel timing analysis attacks.
3. **Exponential Brute-Force Rate Limiting**:
   - Maximum 5 failed attempts within a 15-minute window per IP.
   - 6th failed attempt locks the originating IP address for 15 minutes.
4. **HMAC-SHA256 Encrypted Session Cookies**:
   - Cookie contains client IP, expiration timestamp, and an HMAC signature.
   - Hijacked cookies used from a different IP address are instantly invalidated.
