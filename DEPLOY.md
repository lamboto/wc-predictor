# Deploy: GitHub + Render + GoDaddy domain

How the pieces fit:

- **GitHub** stores the code. (It does *not* run the server — GitHub Pages only serves static sites, and this app is a Node server.)
- **Render** (or Railway/Fly/VPS) pulls the code from GitHub and *runs* it — this is what makes the site live.
- **GoDaddy** gives you a domain name that you point at Render.

A small always-on host with persistent data realistically costs a few dollars/month (Render "Starter" is ~$7/mo and includes the persistent disk this app needs). Render's free tier sleeps after inactivity and resets data, so use a paid instance for a real shared leaderboard.

---

## 1. Put the code on GitHub

In Terminal, inside the `wc-predictor` folder:

```bash
rm -rf .git          # remove any leftover/partial git folder, then start clean
git init
git add .
git commit -m "World Cup Predictor"
```

Then create an empty repo on github.com (the **+** top-right → New repository → name it `wc-predictor` → Create). GitHub shows two lines like:

```bash
git remote add origin https://github.com/YOUR_USERNAME/wc-predictor.git
git branch -M main
git push -u origin main
```

Run those. Your code is now on GitHub. (`data.json` is intentionally **not** uploaded — it's in `.gitignore` so player data/secrets stay private.)

## 2. Run it on Render

1. Go to https://render.com and sign up (you can log in with GitHub).
2. **New +** → **Blueprint** → choose your `wc-predictor` repo. Render reads `render.yaml` and sets everything up (start command + persistent disk).
3. When prompted, fill the environment variables:
   - `ACCESS_CODE` = your team code (e.g. `TEAM2026`)
   - `ADMIN_KEY` = a strong admin password (used by `admin.js`)
   - `FOOTBALL_DATA_API_KEY` = your football-data.org token (optional)
4. Create the service. After it builds, Render gives you a URL like `https://wc-predictor.onrender.com` — open it; you should see the **Team Access** screen.

(No `render.yaml`? Then: **New +** → **Web Service** → connect the repo → Start command `node server.js` → add the env vars above → add a Disk mounted at `/data` and set `DATA_FILE=/data/data.json`.)

## 3. Point your GoDaddy domain at Render

1. In Render: open your service → **Settings** → **Custom Domains** → **Add** your domain (e.g. `cup.yourteam.com` or `yourdomain.com`). Render shows the DNS target.
2. In GoDaddy: **My Products** → your domain → **DNS** → **Manage DNS**.
   - For a subdomain like `cup.yourdomain.com`: add a **CNAME** record — Name `cup`, Value = the target Render gave you (e.g. `wc-predictor.onrender.com`).
   - For the root `yourdomain.com`: Render will give an A record IP (or use an `ALIAS`/forwarding) — follow the exact value Render shows.
3. Wait for DNS to propagate (minutes to a couple of hours). Render auto-issues the HTTPS certificate.

Done — your team opens the domain, enters the access code once, and shares one live leaderboard.

## Running admin against the live site

`admin.js` works on the deployed site too — point it at your domain and pass the admin key:

```bash
BASE=https://cup.yourdomain.com ADMIN_KEY=your_admin_key node admin.js status
BASE=https://cup.yourdomain.com ADMIN_KEY=your_admin_key node admin.js gate "TEAM2026"
BASE=https://cup.yourdomain.com ADMIN_KEY=your_admin_key node admin.js enable-api "your_token"
```

## Updating later

Make changes locally, then:

```bash
git add . && git commit -m "update" && git push
```

Render redeploys automatically on every push. Your data on the `/data` disk is preserved.
