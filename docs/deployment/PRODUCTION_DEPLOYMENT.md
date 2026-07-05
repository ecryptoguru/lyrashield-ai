# LyraShield — Production Deployment Guide

## Production Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Production                                                      │
│                                                                  │
│  ┌────────────┐     ┌──────────────┐     ┌────────────────────┐  │
│  │ Vercel     │     │ Contabo VPS  │     │ Docker Registry    │  │
│  │ (Next.js)  │     │ 10           │     │ (GHCR)             │  │
│  │ Web + API  │     │ (Worker)     │     │ Sandbox image      │  │
│  └─────┬──────┘     └──────┬───────┘     └─────────┬──────────┘  │
│        │                   │                       │             │
│        │          ┌────────┴────────┐              │             │
│        │          │                 │              │             │
│        ├─────────►│  Supabase       │              │             │
│        │          │  (Postgres)     │              │             │
│        │          │                 │              │             │
│        ├─────────►│  Upstash        │              │             │
│        │          │  (Redis)        │              │             │
│        │          └─────────────────┘              │             │
│        │                                           │             │
│        │          ┌─────────────────┐              │             │
│        ├─────────►│  Cloudflare R2  │              │             │
│        │          │  (Evidence S3)  │              │             │
│        │          └─────────────────┘              │             │
│        │                                           │             │
│        │          ┌─────────────────┐              │             │
│        │          │ Brevo           │              │             │
│        └─────────►│ (Email)         │              │             │
│                   └─────────────────┘              │             │
│                                                    │             │
│                   ┌─────────────────┐              │             │
│                   │ Contabo VPS     │◄─────────────┘             │
│                   │ runs Docker     │                            │
│                   │ daemon +        │                            │
│                   │ spawns sandbox  │                            │
│                   │ per scan        │                            │
│                   └─────────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
```

## Phase 1 Production Deployment (MVP)

### Service Breakdown

| Service | Platform | Why | Cost (MVP) |
|---|---|---|---|
| Web + API | Vercel | Best Next.js support, free tier | $0 |
| Worker | Contabo VPS 10 | 4 vCPU AMD EPYC, 8GB RAM, 75GB NVMe, full Docker access | €6.55/mo (~$7) |
| Postgres | Supabase Free | 500MB Postgres + auth + real-time | $0 |
| Evidence Storage | Cloudflare R2 Free | 10GB S3 storage, zero egress fees, free forever | $0 |
| Redis | Upstash Free | 10K commands/day, serverless, TLS | $0 |
| Email | Brevo Free | 300 emails/day, unlimited contacts | $0 |
| Sandbox Image | GitHub Container Registry | Free for public repos | $0 |
| Error Monitoring | Sentry Free | 5K errors/month | $0 |
| DNS | Cloudflare | Free DNS management | $0 |

**Estimated MVP cost: ~$7/month** (Contabo VPS only — everything else free tier)

### Contabo VPS 10 Specs

| Spec | Value |
|---|---|
| CPU | 4 vCPU AMD EPYC (x86) |
| RAM | 8 GB |
| Storage | 75 GB NVMe or 150 GB SSD |
| Network | 200 Mbit/s, unlimited traffic |
| Virtualization | KVM (full root access) |
| Locations | EU, US, UK, Singapore, Japan, Australia, India |
| Price | €6.55/mo (1-month) / €5.24/mo (12-month) |
| Setup fee | None |

x86 AMD EPYC means the existing Kali sandbox image works as-is — no ARM rebuild needed.

### Step 1: Deploy Web App to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# From the monorepo root
cd ~/Desktop/lyrasec-ai

# Link to Vercel project
vercel link

# Configure environment variables in Vercel dashboard:
# DATABASE_URL=<supabase-connection-string>
# REDIS_URL=<upstash-redis-url>
# BETTER_AUTH_SECRET=<strong-secret>
# BETTER_AUTH_URL=https://your-domain.com
# NEXT_PUBLIC_APP_URL=https://your-domain.com
# GITHUB_CLIENT_ID=<from-github-oauth-app>
# GITHUB_CLIENT_SECRET=<from-github-oauth-app>
# S3_ENDPOINT=<r2-endpoint>
# S3_ACCESS_KEY=<r2-access-key>
# S3_SECRET_KEY=<r2-secret-key>
# S3_BUCKET=lyrashield-evidence
# BREVO_API_KEY=<brevo-api-key>

# Deploy
vercel --prod
```

**Vercel config** (`vercel.json` — create in monorepo root):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "cd ../.. && pnpm build --filter @lyrashield/web",
  "outputDirectory": "apps/web/.next",
  "framework": "nextjs",
  "regions": ["iad1"],
  "env": {
    "NEXT_PUBLIC_APP_URL": "@app-url"
  }
}
```

### Step 2: Deploy Worker to Contabo VPS 10

Contabo VPS 10 gives you a full KVM VM with 4 vCPU AMD EPYC, 8GB RAM, 75GB NVMe. Full root access means Docker runs natively — no nested container hacks.

```bash
# 1. Order VPS 10 at https://contabo.com/en-us/vps/cloud-vps-10/
#    - Select region: India (or closest to your users)
#    - Storage: 75 GB NVMe (free)
#    - Image: Ubuntu 22.04
#    - Term: 1 month (€6.55) or 12 months (€5.24/mo)
#    - No setup fee

# 2. Wait for provisioning email (~2-5 minutes)
#    You'll get: IP address, root password

# 3. SSH into the VPS (use a non-root user — see Step 2b)
ssh root@<vps-ip>

# 4. Update system and install Docker
apt update && apt upgrade -y
apt install -y docker.io
systemctl enable docker
systemctl start docker

# 5. Install Node.js 22 + pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pnpm

# 6. Install git and clone the repo
apt install -y git
git clone https://github.com/ecryptoguru/lyrasec-ai.git
cd lyrasec-ai

# 7. Install dependencies and build worker
pnpm install --frozen-lockfile
pnpm build --filter @lyrashield/worker

# 8. Pull the sandbox image
docker pull ghcr.io/lyrashield/lyrashield-sandbox:latest

# 9. Configure environment
cp .env.example .env
nano .env
# Fill in production values (see Step 8 for complete list)

# 10. Test the worker
pnpm --filter @lyrashield/worker start

# 11. Set up as systemd service (auto-restart on reboot)
# IMPORTANT: Run as a dedicated non-root user, NOT root.
# The worker shells out to Docker to run untrusted scan targets —
# a compromise via the sandbox should not give root on the host.
useradd -m -s /bin/bash lyrashield
usermod -aG docker lyrashield
chown -R lyrashield:lyrashield /home/lyrashield/lyrasec-ai

cat > /etc/systemd/system/lyrashield-worker.service << 'EOF'
[Unit]
Description=LyraShield Worker
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=lyrashield
WorkingDirectory=/home/lyrashield/lyrasec-ai/apps/worker
EnvironmentFile=/home/lyrashield/lyrasec-ai/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl enable lyrashield-worker
systemctl start lyrashield-worker

# 12. Verify it's running
systemctl status lyrashield-worker
journalctl -u lyrashield-worker -f  # tail logs
```

**Firewall + SSH hardening** (only allow SSH + outbound):

```bash
# Disable password auth — key-only SSH
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Firewall: only SSH + outbound
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw enable

# Optional: restrict SSH to a known source IP
# ufw allow from <your-office-ip> to any port 22
```

### Step 3: Set Up Supabase (Postgres)

Supabase gives you 500MB Postgres + 50K auth users for free.

```bash
# 1. Sign up at https://supabase.com (free, no credit card)
# 2. Create a new project
# 3. Wait for provisioning (~2 minutes)

# Postgres connection:
# Settings → Database → Connection string → URI
# Format: postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require

# Run migrations against Supabase
cd ~/Desktop/lyrasec-ai
DATABASE_URL="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require" pnpm db:migrate
DATABASE_URL="postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require" pnpm db:generate

# Set in Vercel + Contabo VPS:
# DATABASE_URL=postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require
```

**Supabase Free Tier Limits**:

- 500MB Postgres (upgrade to Pro for $25/mo when you need more)
- 50,000 monthly active users (auth)
- 2GB bandwidth

### Step 4: Set Up Evidence Storage (Cloudflare R2)

R2 gives you 10GB S3-compatible storage with **zero egress fees** — free forever, no time limit.

```bash
# 1. Sign up at https://cloudflare.com (free, no credit card)
# 2. R2 → Create bucket → "lyrashield-evidence" (private)
# 3. R2 → Manage R2 API Tokens → Create API Token
#    - Permissions: Object Read & Write
#    - Specify bucket: lyrashield-evidence
# 4. Copy: Access Key ID, Secret Access Key, Endpoint URL
# 5. Set in Vercel + Contabo VPS:
#    S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
#    S3_ACCESS_KEY=<r2-access-key>
#    S3_SECRET_KEY=<r2-secret-key>
#    S3_BUCKET=lyrashield-evidence
#    S3_REGION=auto
```

**R2 Free Tier Limits**:

- 10 GB storage (then $0.015/GB/month)
- 1M Class A operations (writes) per month
- 10M Class B operations (reads) per month
- **Zero egress fees** — unlimited downloads, free forever
- No time limit — free forever, not a trial

**Why R2 over Supabase Storage**: 10x more storage (10GB vs 1GB), zero egress fees (Supabase counts downloads against 2GB bandwidth), and purpose-built for object storage.

### Step 5: Set Up Redis (Upstash)

```bash
# 1. Sign up at https://upstash.com (free, no credit card)
# 2. Create a Redis database
# 3. Copy connection string (use the rediss:// URL for TLS)
#    Format: rediss://default:<password>@<instance>.upstash.io:6379
# 4. Set as REDIS_URL in Vercel + Contabo VPS
#    REDIS_URL=rediss://default:<password>@<instance>.upstash.io:6379

# Free tier: 10,000 commands/day, 256MB max data size
# Plenty for MVP — BullMQ queues are lightweight
```

### Step 6: Build & Push Sandbox Image

```bash
cd ~/Desktop/lyrashield-engine/containers

# Build the sandbox image
docker build -t ghcr.io/lyrashield/lyrashield-sandbox:latest -f Dockerfile ..

# Push to GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u <your-github-username> --password-stdin
docker push ghcr.io/lyrashield/lyrashield-sandbox:latest

# Tag a version
docker tag ghcr.io/lyrashield/lyrashield-sandbox:latest ghcr.io/lyrashield/lyrashield-sandbox:v0.1.0
docker push ghcr.io/lyrashield/lyrashield-sandbox:v0.1.0
```

### Step 7: Set Up GitHub OAuth App

```bash
# 1. Go to https://github.com/settings/developers
# 2. New OAuth App
#    Homepage URL: https://your-domain.com
#    Authorization callback URL: https://your-domain.com/api/auth/callback/github
# 3. Copy Client ID and Client Secret
# 4. Set in Vercel:
#    GITHUB_CLIENT_ID=<client-id>
#    GITHUB_CLIENT_SECRET=<client-secret>
```

### Step 8: Set Up GitHub App (for repo scanning)

```bash
# 1. Go to https://github.com/settings/apps
# 2. New GitHub App
#    App name: LyraShield
#    Homepage URL: https://your-domain.com
#    Webhook URL: https://your-domain.com/api/webhooks/github
#    Webhook secret: <generate strong secret>
#    Repository permissions:
#      - Contents: Read-only
#      - Pull requests: Read & write
#      - Metadata: Read-only
#    Subscribe to events: Pull request, Installation
# 3. Generate private key (download .pem file)
# 4. Store in Infisical or secrets manager:
#    GITHUB_APP_ID=<app-id>
#    GITHUB_APP_PRIVATE_KEY=<contents-of-pem-file>
#    GITHUB_WEBHOOK_SECRET=<webhook-secret>
```

### Step 9: Set Up Email (Brevo)

```bash
# 1. Sign up at https://www.brevo.com (free, no credit card)
# 2. Verify your email address
# 3. Settings → API Keys → Generate
# 4. Copy API key
# 5. Set in Vercel + Contabo VPS:
#    BREVO_API_KEY=<api-key>
#    EMAIL_FROM="LyraShield <noreply@your-domain.com>"

# Free tier: 300 emails/day, unlimited contacts
```

### Step 10: Set Up Error Monitoring (Sentry)

```bash
# 1. Sign up at https://sentry.io (free, 5K errors/month)
# 2. Create a Next.js project → get DSN
# 3. Create a Node project (for worker) → get DSN
# 4. Set in Vercel:
#    SENTRY_DSN=<nextjs-dsn>
#    NEXT_PUBLIC_SENTRY_DSN=<nextjs-dsn>
# 5. Set in Contabo VPS .env:
#    SENTRY_DSN=<node-dsn>
```

### Step 11: Configure DNS

```bash
# In Cloudflare (free DNS):
# Add your domain to Cloudflare
# A/CNAME record: your-domain.com → Vercel
# CNAME record: www.your-domain.com → Vercel
```

## CI/CD Pipeline

### GitHub Actions — Web (Vercel auto-deploys)

Vercel auto-deploys on push to main. No GitHub Actions needed for web.

### GitHub Actions — Worker (deploy to Contabo VPS)

Create `.github/workflows/deploy-worker.yml`:

```yaml
name: Deploy Worker

on:
  push:
    branches: [main]
    paths:
      - "apps/worker/**"
      - "packages/**"

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build --filter @lyrashield/worker

      - name: Deploy to Contabo VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.WORKER_VPS_IP }}
          username: lyrashield
          key: ${{ secrets.WORKER_VPS_SSH_KEY }}
          script: |
            cd /home/lyrashield/lyrasec-ai
            git pull origin main
            pnpm install --frozen-lockfile
            pnpm build --filter @lyrashield/worker
            systemctl restart lyrashield-worker
```

### GitHub Actions — Engine

In the `lyrashield-engine` repo, create `.github/workflows/build-sandbox.yml`:

```yaml
name: Build Sandbox Image

on:
  push:
    branches: [main]
    paths:
      - "containers/**"
      - "lyrashield/**"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build sandbox image
        run: |
          cd containers
          docker build -t ghcr.io/lyrashield/lyrashield-sandbox:latest -f Dockerfile ..
      - name: Push to GHCR
        run: |
          echo ${{ secrets.GITHUB_TOKEN }} | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          docker push ghcr.io/lyrashield/lyrashield-sandbox:latest
          docker tag ghcr.io/lyrashield/lyrashield-sandbox:latest ghcr.io/lyrashield/lyrashield-sandbox:${{ github.sha }}
          docker push ghcr.io/lyrashield/lyrashield-sandbox:${{ github.sha }}
```

## Production Environment Variables (Complete)

```env
# Database (Supabase)
DATABASE_URL=postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require

# Redis (Upstash — TLS)
REDIS_URL=rediss://default:<password>@<instance>.upstash.io:6379

# Auth
BETTER_AUTH_SECRET=<32+char-random-string>
BETTER_AUTH_URL=https://your-domain.com

# App
NEXT_PUBLIC_APP_URL=https://your-domain.com
NODE_ENV=production

# GitHub OAuth
GITHUB_CLIENT_ID=<client-id>
GITHUB_CLIENT_SECRET=<client-secret>

# GitHub App (for repo scanning)
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=<pem-contents>
GITHUB_WEBHOOK_SECRET=<webhook-secret>

# Engine
LYRASHIELD_LLM=openai/gpt-4o
LLM_API_KEY=sk-...
LYRASHIELD_IMAGE=ghcr.io/lyrashield/lyrashield-sandbox:v0.1.0

# Evidence Storage (Cloudflare R2)
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY=<r2-access-key>
S3_SECRET_KEY=<r2-secret-key>
S3_BUCKET=lyrashield-evidence
S3_REGION=auto

# Email (Brevo)
BREVO_API_KEY=<api-key>
EMAIL_FROM=LyraShield <noreply@your-domain.com>

# Billing (Sprint 10)
POLAR_ACCESS_TOKEN=<token>
POLAR_WEBHOOK_SECRET=<secret>
RAZORPAY_KEY_ID=<key-id>
RAZORPAY_KEY_SECRET=<key-secret>

# Monitoring
SENTRY_DSN=<dsn>
NEXT_PUBLIC_SENTRY_DSN=<dsn>
```

## Backup & Restore

### Postgres (Supabase)

Supabase Free tier includes daily automatic backups with 7-day retention.

```bash
# Manual backup (pg_dump — run from VPS or local)
pg_dump "postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require" \
  --no-owner --no-privileges -F c -f backup-$(date +%Y%m%d).dump

# Restore (to a new Supabase project or local)
pg_restore --dbname "postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require" \
  --no-owner --no-privileges backup-20260705.dump
```

**RPO:** 24h (Supabase automatic) · **RTO:** <1h (manual pg_restore)

### Cloudflare R2 (Evidence Storage)

R2 does NOT provide automatic versioning by default. Enable it:

```bash
# Enable versioning on the evidence bucket (via Cloudflare dashboard or API)
# Dashboard → R2 → lyrashield-evidence → Settings → Object Versioning → Enable

# Or via wrangler CLI:
wrangler r2 bucket versioning put lyrashield-evidence --enabled
```

**Backup strategy:**
- Enable R2 object versioning (protects against accidental deletes/overwrites)
- Periodic sync to a secondary bucket or local storage (for disaster recovery)
- Evidence retention is governed by `Policy.evidenceRetentionDays` (default 30d)

**RPO:** Real-time (versioning) · **RTO:** <5min (version restore)

## Scaling Considerations

### When to upgrade from free tiers

| Trigger | Action | Cost |
|---|---|---|
| > 500MB DB data | Supabase Pro | $25/mo |
| > 10GB evidence storage | R2 paid ($0.015/GB) | ~$0.15/GB extra |
| > 300 emails/day | Brevo Starter | $9/mo |
| > 10K Redis commands/day | Upstash Pay-as-you-go | $0.2/100K cmds |
| > 10 concurrent scans | Add 2nd Contabo VPS | €6.55/mo extra |
| > 10K users | Supabase Team | $25/mo |
| > 50K scans/month | Move worker to Kubernetes | varies |

### Worker scaling (Contabo)

```bash
# Add a 2nd VPS and run worker on both
# Both connect to the same Redis queue
# BullMQ distributes jobs across workers automatically

# VPS 1: lyrashield-worker-1 (4 cores, 8GB RAM)
# VPS 2: lyrashield-worker-2 (4 cores, 8GB RAM) — €6.55/mo extra
```

### Database connection pooling

Supabase includes PgBouncer:

```env
# Use the pooler connection (port 6543 instead of 5432)
DATABASE_URL=postgresql://postgres:<password>@db.<project>.supabase.co:6543/postgres?pgbouncer=true
```

## Phase 2 — Enterprise Deployment

### Self-Hosted / VPC Deployment

```txt
Customer VPC
├── LyraShield Web (Docker)
├── LyraShield Worker (Docker)
├── LyraShield Engine (Docker)
├── Postgres (customer-managed or RDS)
├── Redis (customer-managed or ElastiCache)
├── Object Storage (S3 in customer account)
├── Secret Vault (customer KMS / Secrets Manager)
└── License Key Service (LyraShield-hosted)
```

### Kubernetes Deployment (Helm)

```bash
# Add Helm chart (Sprint 19)
helm repo add lyrashield https://charts.lyrashield.ai
helm install lyrashield lyrashield/lyrashield \
  --set licenseKey=<license-key> \
  --set database.url=<postgres-url> \
  --set redis.url=<redis-url>
```

## Security Checklist (Production)

- [ ] BETTER_AUTH_SECRET is 32+ characters and generated with `openssl rand -base64 32`
- [ ] All secrets stored in Infisical or cloud secrets manager (not in .env files in git)
- [ ] Worker runs as a dedicated non-root user (NOT root)
- [ ] SSH password auth disabled (key-only)
- [ ] SSH access restricted to known source IPs (optional but recommended)
- [ ] DATABASE_URL uses SSL (`?sslmode=require`)
- [ ] REDIS_URL uses TLS (`rediss://`)
- [ ] R2 bucket has object versioning enabled
- [ ] Database backups are configured (Supabase automatic + periodic pg_dump)
- [ ] CORS configured to only allow your domain
- [ ] Rate limiting enabled on auth endpoints
- [ ] GitHub webhook secret is set and verified
- [ ] Sandbox image is pinned to a specific version (not :latest in production)
- [ ] Sentry error monitoring is active
- [ ] Evidence storage bucket is private (no public read access)
- [ ] LLM API key has spending limits set at the provider level
- [ ] Worker VPS firewall only allows port 22 (SSH) and outbound
- [ ] Worker VPS SSH key is not shared
