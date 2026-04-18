# Deploying Nocturne

Nocturne runs on a single Aliyun ECS box at `root@120.27.115.75` as a
systemd-managed Bun binary behind nginx, fronted at
`https://nocturne.eanzhao.com` (and `https://nocturne.eanz.cn`).

This directory holds **reference copies** of the host-side config that the
`deploy-nocturne` skill writes inline during first-time setup:

| File | Live location on ECS |
|---|---|
| `systemd/nocturne.service` | `/etc/systemd/system/nocturne.service` |
| `nginx/nocturne.conf`      | `/etc/nginx/conf.d/nocturne.conf` |

If you change either, update both the skill (`~/.claude/skills/deploy-nocturne/SKILL.md`,
Setup 5 / Setup 6) and these files in the same commit so the two don't drift.

---

## Prerequisites

- **Mac dev box**
  - Bun installed (`bun --version`).
  - SSH access to `root@120.27.115.75` (ECS box; SSH key already authorized).
  - `deploy-nocturne` skill available at `~/.claude/skills/deploy-nocturne/SKILL.md`.
- **ECS box** (verify once at first deploy)
  - nginx installed, listening on :80 and :443.
  - SSL certs present at `/etc/nginx/ssl/eanzhao.com.{pem,key}` and
    `/etc/nginx/ssl/eanz.cn.{pem,key}`.
  - Port 7701 free on `127.0.0.1` (the Bun service binds here; if taken,
    pick another port in the 7700–7799 range and update both the systemd
    unit and the nginx `proxy_pass`).
  - `/opt/nocturne/.env` populated (see Setup 4 in the skill) with
    `chmod 600`.
- **Upstream services reachable from the ECS box**
  - Supabase Postgres (via `DATABASE_URL`, sourced from
    `~/.supabase-credentials` on the Mac).
  - chrono-storage at `http://127.0.0.1:3805` (same box, internal).
  - NyxID at `https://nyx-api.chrono-ai.fun`.

## Build

From the repo root on the Mac:

```bash
bun run build
```

Produces a self-contained Linux x64 binary at `dist/nocturne` (see
`package.json` → `scripts.build`).

## Deploy

Use the `deploy-nocturne` skill's **Routine deploy** — five steps, under a
minute end-to-end. They live in `~/.claude/skills/deploy-nocturne/SKILL.md`
under the heading "Routine deploy (after first-time setup)". In short:

1. `bun run build` → `dist/nocturne`.
2. `tar czf /tmp/nocturne.tar.gz -C dist nocturne` (plus `public/` and
   `templates/` if they exist in this version).
3. `scp /tmp/nocturne.tar.gz root@120.27.115.75:/tmp/`.
4. SSH in, extract to `/opt/nocturne`, `chmod +x /opt/nocturne/nocturne`.
5. `systemctl restart nocturne` and verify.

Do not bypass the skill on routine deploys — it keeps the host-side steps
consistent with the rest of the eanzhao.com fleet.

## Post-deploy smoke checks

Run each of these. All four should succeed — one failure means roll back.

```bash
# 1. systemd reports active (running)
ssh root@120.27.115.75 "systemctl status nocturne --no-pager | head -20"

# 2. health endpoint
curl -sk https://nocturne.eanzhao.com/health
# expected: {"status":"ok","service":"nocturne",...}

# 3. OpenAPI document served
curl -sk https://nocturne.eanzhao.com/openapi.json | jq '.info.title'
# expected: "Nocturne" (or similar)

# 4. no errors in the last 50 log lines
ssh root@120.27.115.75 "journalctl -u nocturne -n 50 --no-pager" | grep -iE 'error|fatal' || echo "clean"
# expected: "clean"  (grep exits non-zero → the `|| echo` fires)
```

Optional: tail logs for 30 s right after restart and watch for ERROR lines:

```bash
ssh root@120.27.115.75 "journalctl -u nocturne -f --since '30 seconds ago'"
```

## Fallback: NyxID admin registration blocks the deploy

Setup 3 of the skill registers Nocturne in the NyxID service catalog via an
admin-only REST call. If this fails (non-admin token, shape drift, NyxID
outage), the API path is not blocked — callers can still hit Nocturne
directly, skipping the NyxID proxy, using a temporary static bearer token.

Set it inline on the ECS box until NyxID registration succeeds:

```bash
ssh root@120.27.115.75 "cat >> /opt/nocturne/.env" <<'EOF'
# TEMPORARY — remove once NyxID service registration completes.
# Generate with: openssl rand -hex 32
NOCTURNE_STATIC_BEARER=<hex-secret-32-bytes>
EOF
ssh root@120.27.115.75 "systemctl restart nocturne"
```

The server should accept `Authorization: Bearer $NOCTURNE_STATIC_BEARER` as
an alternative to the NyxID JWT path so the box can be smoke-tested end to
end without the proxy. Document the token out-of-band, rotate it the moment
the NyxID path comes online, and **delete the line from `.env`** (plus
restart) afterwards — this escape hatch is not meant to stay.

## Rollback

No history is kept on the ECS side. Rebuild from an earlier commit and
re-run the routine deploy:

```bash
cd ~/Code/Nocturne && git checkout <older-commit> -- src/
bun run build
# then routine deploy steps 2–5 above
git checkout HEAD -- .
```

## Related

- `systemd/nocturne.service` — reference copy of the unit file.
- `nginx/nocturne.conf` — reference copy of the server blocks.
- `~/.claude/skills/deploy-nocturne/SKILL.md` — the actual deploy runner.
- Issue [#11](https://github.com/eanzhao/Nocturne/issues/11) — first-deploy
  tracking issue; stays open until the Saturday-morning dry run completes.
