# VidLyte — Blitz.cloud Deployment Guide

This guide details how to deploy your **VidLyte High-Performance HLS Gateway & Embed Player** onto [blitz.cloud](https://blitz.cloud) using their European cloud infrastructure, isolated gVisor container runtime, and free automated HTTPS subdomains.

---

## 1. Why Blitz.cloud for VidLyte?

- **Container Native**: Blitz.cloud natively runs standard `linux/amd64` Dockerfiles.
- **Automatic SSL & Subdomain**: Provides instantaneous HTTPS on `https://<app>.<user>.blitz.cloud`.
- **Zero-Friction Build**: Automatically builds directly from your connected GitHub repository and triggers auto-rebuilds on each `git push`.
- **Fast Startup**: Pure Go binary compiles in seconds and boots in <10ms inside the gVisor sandbox.
- **Free Tier Compatible**: Spins down on idle and wakes up instantly on the first incoming video request.

---

## 2. Step 1: Push Your Code to GitHub

Blitz.cloud connects directly to GitHub repositories.

If you haven't created a GitHub repository yet:
1. Go to [GitHub](https://github.com/new) and create a new repository (e.g., `vidlyte` or `byse-resolver`). You can make it **Public** or **Private**.
2. In your local terminal, add the remote and push:

```bash
# Set default branch to main
git branch -M main

# Add all project source files (binaries and secrets are already ignored)
git add .
git commit -m "feat: complete VidLyte gateway with Docker & Blitz.cloud compatibility"

# Link your GitHub repository (replace with your actual GitHub URL)
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git

# Push to GitHub
git push -u origin main
```

---

## 3. Step 2: Deploy on Blitz.cloud Dashboard

1. **Sign In**: Navigate to [dashboard.blitz.cloud](https://dashboard.blitz.cloud) and sign in (via GitHub, Google, or Email).
2. **Start Deployment**: Click the button **"Host something new"**.
3. **Select Source**:
   - Choose **"My own code"** to select your connected GitHub repository, OR
   - Paste the direct URL of your public GitHub repository.
4. **Configure Subdomain**:
   - Enter your app name (e.g. `vidlyte`).
   - Blitz will assign your live HTTPS endpoint: `https://vidlyte.<your-username>.blitz.cloud`.
5. **Port & Build Configuration**:
   - Blitz automatically detects the root `Dockerfile`.
   - The container exposes port `8080`, which Blitz maps behind its HTTPS edge proxy.

---

## 4. Step 3: Configure Environment Variables

Before or immediately after launching, go to your app's **Settings** -> **Environment Variables** in the Blitz.cloud dashboard and add the following keys:

| Environment Variable | Recommended Value / Format | Purpose |
| :--- | :--- | :--- |
| `ENV` | `production` | Enables production security & SSRF private IP blocking |
| `PORT` | `8080` | Core hub HTTP listener port |
| `PLAYER_PORT` | `none` | Disables secondary dev listener for single-port containers |
| `LOG_LEVEL` | `info` | JSON structured log verbosity (`info` or `debug`) |
| `VIDLYTE_ADMIN_SECRET` | 64-character random hex string | Password for the secret admin mission control (`/admin-login-i`) |
| `STREAM_SECRET` | 64-character random hex string | Cryptographic key for M3U8 proxy token signing |
| `GATEWAY_HMAC_SECRET` | 64-character random hex string | Timed session playback token signing key |
| `GATEWAY_TOKEN_TTL` | `4h` | Playback session token expiration window |
| `GATEWAY_UPSTREAM_HOSTS` | `img.animecurx.tech,sacdn.hakunaymatata.com,bcdn.hakunaymatata.com,embed.vidrift.net,mb.vidrift.net,api.framextv.xyz,api.framextv.cc,api.framextv.tech,framextv.cc,framextv.xyz,api.wing.st,cinejoy.pk,rumble.com,hugh.cdn.rumble.cloud,res.cloudinary.com,www.blogger.com,asianflix.one,api.themoviedb.org,127.0.0.1,localhost,cache.vdrk.site,vdrk.site,workers.dev` | SSRF security whitelist |
| `TMDB_API_KEY` | *(Optional)* | TMDB API v3 key for automatic movie/series metadata |
| `UPSTASH_REDIS_REST_URLS` | *(Optional)* Comma-separated URLs | Distributed multi-node Redis cache cluster |
| `UPSTASH_REDIS_REST_TOKENS` | *(Optional)* Comma-separated tokens | Auth tokens for Upstash Redis nodes |

> [!TIP]
> You can generate secure random 64-character hex secrets using PowerShell:
> ```powershell
> -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
> ```

---

## 5. Step 4: Launch & Verification

Click **"Build it and put it online"**.

Blitz.cloud will:
1. Spin up the Alpine Linux build container.
2. Compile the static Go binary (`/app/vidlyte`).
3. Deploy the runtime container into an isolated gVisor sandbox.
4. Issue an automatic Let's Encrypt SSL certificate.

### Verifying Live Endpoints

Once the deployment reaches `Ready`, test the following URLs in your browser (replace `https://vidlyte.<your-username>.blitz.cloud` with your actual subdomain):

1. **Public Webmaster Portal & Live Embed Builder**:
   ```
   https://vidlyte.<your-username>.blitz.cloud/
   ```
2. **Instant Embed Player (TV Series Example)**:
   ```
   https://vidlyte.<your-username>.blitz.cloud/embed/tv/289423/1/1
   ```
3. **Instant Embed Player (Movie Example)**:
   ```
   https://vidlyte.<your-username>.blitz.cloud/embed/movie/1058424
   ```
4. **Secret Mission Control / Admin Console**:
   ```
   https://vidlyte.<your-username>.blitz.cloud/admin-login-i
   ```
   *(Log in with the secret string you defined in `VIDLYTE_ADMIN_SECRET`)*
5. **Health Check**:
   ```
   https://vidlyte.<your-username>.blitz.cloud/healthz
   ```

---

## 6. Continuous Deployment & Updates

Whenever you make improvements or fixes locally:
```bash
git add .
git commit -m "update: improvements"
git push origin main
```
Blitz.cloud automatically detects the new commit on GitHub, initiates a rolling build, and deploys the update with zero downtime.
