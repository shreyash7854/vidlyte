# VidLyte — Zero-Cost Free-Tier Deployment & Free Domains Guide

This guide explains how to host your **VidLyte** service for **$0 / completely free** until your Adsterra popunders start generating revenue.

---

## 1. Hosting Architecture on Free Tier Providers

Free-tier providers (such as **Render**, **Koyeb**, or **Railway**) allocate a container and expose a single HTTP port through an environment variable (`$PORT`).

The VidLyte Go codebase is architected with **Zero Dependencies (Pure Go Standard Library)**, meaning:
1. **Single Portable Binary**: Compiles in ~5 seconds and uses less than 25MB of RAM.
2. **Unified Single-Port / Multi-Domain Routing**:
   - If deployed on Render/Koyeb with only 1 port exposed, VidLyte automatically routes:
     - The Public Landing Page & Embed Builder at `/`
     - The Secret Admin Console at `/admin-login-i`
     - The Video Player Embeds at `/embed/*`
     - The HLS Streaming Gateway at `/hls/*`
   - If a custom player domain/subdomain points to the same service, it handles it smoothly with zero extra servers.
3. **Decoupled Local / Multi-Port Mode**:
   - In local development or on a VPS, VidLyte automatically starts two independent listeners:
     - Main Hub & Admin on `http://localhost:8080`
     - Autonomous Player Edge on `http://localhost:6789`

---

## 2. Deploying on Render (Free Web Service)

Render provides a 100% free web service tier with automated GitHub deployment and free custom domains with automatic SSL.

### Step-by-Step Render Deployment:
1. Push your repository to **GitHub** (e.g. `github.com/your-username/vidlyte`).
2. Go to [dashboard.render.com](https://dashboard.render.com/) and click **New +** -> **Web Service**.
3. Select your GitHub repository.
4. Fill in the build settings:
   - **Name**: `vidlyte-hub` (or your choice)
   - **Environment**: `Go`
   - **Build Command**: `go build -o resolver .`
   - **Start Command**: `./resolver`
   - **Instance Type**: **Free**
5. Add Environment Variables:
   - `VIDLYTE_ADMIN_SECRET`: Set a 32-character password (e.g., `v1_9a87f2e1c4b5d6e8a0b1c2d3e4f5a6b7`)
   - `GATEWAY_HMAC_SECRET`: Set a 32-character hex secret for HLS token signing
   - `APP_ENV`: `production`
6. Click **Create Web Service**.
7. Once deployed, Render gives you a free URL: `https://vidlyte-hub.onrender.com`.

---

## 3. Free Subdomains & Free Domains (No Spending Required)

You do **not** need to buy domains to get started. You can use any of these free options:

### Option A: Render / Koyeb Free Subdomains (Zero Setup)
* Your Render app already has a free HTTPS subdomain: `https://vidlyte-hub.onrender.com`.
* In your secret admin console (`/admin-login-i`), set the Primary Player Domain to `https://vidlyte-hub.onrender.com`.
* The embed builder will automatically emit iframe codes using this domain.

### Option B: Free DuckDNS Subdomains (100% Free Forever)
1. Go to [duckdns.org](https://www.duckdns.org/) and log in.
2. Create two free subdomains:
   - `vidlyte-main.duckdns.org`
   - `vidlyte-player.duckdns.org`
3. Point them to your server's public IP or CNAME to Render.

### Option C: Cloudflare Free Tier with a Cheap $1–$2 Domain
* If you acquire a cheap TLD (e.g., `.xyz`, `.site`, or `.top` for ~$1–$2/year from Namecheap/Porkbun):
* Connect the nameservers to **Cloudflare (Free Plan)**:
  - Create `vidlyte.yourdomain.xyz` for the Main Site.
  - Create `embed.yourdomain.xyz` for the Player.
  - Enable Cloudflare **Proxy (Orange Cloud)** for free DDoS protection, CDN caching, and automatic SSL.
* When you add or change player subdomains in `/admin-login-i`, the main site updates immediately with zero server restarts.

---

## 4. Setting up Adsterra Popunder Ads for Revenue

1. Log in to your **Adsterra Publisher Dashboard** (`publishers.adsterra.com`).
2. Go to **Direct Links (Smartlinks)** and click **Get Code**.
3. Copy your Smartlink URL (e.g. `https://beta.smartlink.example/click?key=...`).
4. Open your secret VidLyte console:
   - URL: `https://your-domain.com/admin-login-i`
   - Enter your `VIDLYTE_ADMIN_SECRET`.
5. Navigate to the **Monetization & Ads** tab:
   - Toggle **Enable Player Popunder Ads** to ON.
   - Paste your **Adsterra Smartlink URL**.
   - Set **Max Popunders Per User** (default: `2` per 24 hours).
   - Set **Cooldown** (default: `15` minutes).
   - Set **Trigger Event**: `Play Button Click`.
6. Click **Save Changes**.
7. Test the video player:
   - As soon as a user clicks Play, the Adsterra smartlink opens in a new background tab while the video begins streaming in the foreground.
   - Once the user has seen 2 popunders, no further ads interrupt them for the day.

---

## 5. Security & Availability Summary

* **Main Site Never Stops**: Even if an ad network or copyright notice targets an embed domain, your main hub (`/`) and admin portal (`/admin-login-i`) stay 100% online.
* **Instant Player Rotation**: Simply add your new free subdomain in `/admin-login-i` and click **Set Primary**.
* **Zero Maintenance Overhead**: Pure Go standard library, single executable, zero external database dependencies.
