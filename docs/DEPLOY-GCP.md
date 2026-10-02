# Deploy on a GCP Ubuntu VM with Docker

Stack on one VM: Caddy (HTTPS and site password) -> web -> api -> Postgres. Only ports 80 and 443 are public.

Status: the compose file validates, but the images have not been built or run in the environment where this was written. Expect to fix small things on the first run.

## 1. VM and firewall
- Compute Engine VM, Ubuntu 22.04 or 24.04, e2-medium or larger (2 vCPU, 4 GB), 30 GB disk.
- Allow HTTP and HTTPS in the firewall. Do not open 5432 or 4000.
- Reserve a static external IP. Point a DNS A record (for example `work.example.com`) at it.

## 2. Install Docker
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

## 3. Get the code and configure
```bash
git clone https://github.com/javedjst/javedtest2.git && cd javedtest2
cp .env.prod.example .env
# fill in with: openssl rand -hex 24 / openssl rand -base64 32
docker run --rm caddy:2 caddy hash-password --plaintext 'choose-a-site-password'
nano .env
```
In `.env`, escape every `$` in the Caddy hash as `$$`. Set `PUBLIC_URL=https://work.example.com` and `DOMAIN=work.example.com`. No domain yet: use `PUBLIC_URL=http://<vm-ip>` and `DOMAIN=:80`.

## 4. Start
```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm migrate npm run seed -w apps/api   # demo data
docker compose -f docker-compose.prod.yml ps
curl -s localhost/api/health -u admin:'choose-a-site-password'     # {"ok":true,...}
```
Open `PUBLIC_URL`, enter the site password, then sign in as `javed@acme.test`.

## 5. Operate
```bash
docker compose -f docker-compose.prod.yml logs -f api            # logs
git pull && docker compose -f docker-compose.prod.yml up -d --build   # update (migrations run automatically)
docker compose -f docker-compose.prod.yml exec db pg_dump -U postgres aiworkhub > backup.sql   # backup
```
Back up `.env`, especially `MASTER_KEY`. Losing it makes stored integration tokens unreadable.

## Limits
- No real login yet. The site password from Caddy is the only protection, so use a strong one and HTTPS.
- Do not put real company mail in it until SSO exists and `NODE_ENV=production`, `DEV_AUTH=false`.
- `MASTER_KEY` sits in a file on the VM. The KMS wrapper from the security doc is not built.
- Single VM, no automatic failover. Set up disk snapshots in GCP.
