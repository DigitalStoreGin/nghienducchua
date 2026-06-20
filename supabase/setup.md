# ShadowEcho — Supabase Setup Guide

## 1. Create Supabase Project

1. Go to https://supabase.com → **New Project**
2. Choose a region close to Vietnam (Singapore `ap-southeast-1`)
3. Set a strong database password
4. Wait for project to spin up (~2 minutes)

## 2. Run Migrations

1. Go to **SQL Editor** in Supabase Dashboard
2. Click **New Query**
3. Paste the contents of `migrations/001_initial.sql`
4. Click **Run**

## 3. Get Credentials

Go to **Settings → API**:

| Field | Where |
|-------|-------|
| `SUPABASE_URL` | Project URL (e.g. `https://abcxyz.supabase.co`) |
| `SUPABASE_ANON_KEY` | `anon` `public` key |
| `SUPABASE_SERVICE_KEY` | `service_role` `secret` key |

## 4. Update Extension Config

Edit `shadowing-extension/config.js`:

```js
const CONFIG = Object.freeze({
  SUPABASE_URL:      'https://YOUR_PROJECT_ID.supabase.co',   // ← replace
  SUPABASE_ANON_KEY: 'eyJ...',                                 // ← replace  
  WORKER_URL:        'https://nghienducchua-proxy.thoatran21012.workers.dev',
});
```

## 5. Update Cloudflare Worker Secrets

```bash
cd worker
npx wrangler secret put SUPABASE_URL
# → enter: https://YOUR_PROJECT_ID.supabase.co

npx wrangler secret put SUPABASE_SERVICE_KEY
# → enter: service_role key (sb_secret_...)

npx wrangler secret put DEEPL_API_KEY
# → enter your DeepL API key

npx wrangler secret put OPENROUTER_API_KEY
# → enter your OpenRouter API key

npx wrangler secret put ADMIN_KEY
# → enter: generate a strong key e.g. ADMIN-$(openssl rand -hex 16)

npx wrangler deploy
```

## 6. Enable Email Auth in Supabase

1. Go to **Authentication → Providers**
2. Enable **Email** provider
3. (Optional) Configure SMTP for custom emails

## 7. Admin: Upgrade User Plan

```bash
# Upgrade user to Pro for 12 months
curl -X POST https://nghienducchua-proxy.thoatran21012.workers.dev/admin/upgrade \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "UUID_FROM_SUPABASE_AUTH", "plan": "pro", "months": 12}'
```

## Plan Quotas

| Plan | Translations/day | AI calls/day | Price |
|------|-----------------|--------------|-------|
| Free | 20 | 10 | Free |
| Basic | 200 | 100 | $4.99/mo |
| Pro | 2,000 | 1,000 | $9.99/mo |
| Lifetime | Unlimited | Unlimited | $49.99 once |
