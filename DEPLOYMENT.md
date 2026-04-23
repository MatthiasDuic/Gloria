# Gloria KI-Assistent - Deployment Guide

## Production Status ✅

**Last Deploy:** April 21, 2026 via `npx vercel deploy --prod`  
**URL:** https://gloria-ki-assistant.vercel.app (aliased to gloria.agentur-duic-sprockhoevel.de)  
**Health Check:** `/api/health` → 200 OK  
**E2E Validation:** 14/14 tests passing

---

## Core Features Deployed

### 1. **Multi-Tenant Architecture**
- ✅ User authentication via cookie sessions (`gloria_session`)
- ✅ Role-based access control (master/user)
- ✅ User-scoped data isolation (scripts, reports, leads, campaigns)
- ✅ PostgreSQL on Render with userId foreign keys

### 2. **Telephony Pipeline (Twilio + OpenAI Chat + ElevenLabs)**
- ✅ Inbound call routing via `/api/twilio/voice`
- ✅ Outbound campaign calling via `/api/campaigns/lists`
- ✅ User-scoped script caching in `telephony-runtime.ts`
- ✅ Script origin tracking in call reports
- ✅ AI conversation loop with ElevenLabs voice synthesis
- ✅ Call completion webhooks → report persistence

### 3. **Campaign Management**
- ✅ CSV/XLS import with auto-parsing (`/api/campaigns/import`)
- ✅ Lead persistence in PostgreSQL
- ✅ Campaign list state management (`/api/campaigns/lists`)
- ✅ Manual + scheduled callback support (`/api/callbacks/run`)

### 4. **Admin Interface**
- ✅ User management (`/api/admin/users`)
- ✅ Phone number configuration (`/api/admin/phone-numbers`)
- ✅ Learning/script management (`/api/learning`)
- ✅ Report export to Outlook (`/api/export/outlook`)

### 5. **Security**
- ✅ Basic Auth for internal APIs (BASIC_AUTH_USERNAME=MDUIC)
- ✅ Call state tokens for Twilio callback validation
- ✅ Cron job protection via CRON_SECRET
- ✅ User scope guards on learning/reporting endpoints

---

## Key Configuration Files

### Environment (.env.local)
```
APP_BASE_URL=
BASIC_AUTH_USERNAME=
BASIC_AUTH_PASSWORD=
CALL_STATE_SECRET=
CRON_SECRET=
DATABASE_URL=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
```

### Build & Runtime
- Next.js 16.2.3 (App Router, TypeScript)
- Vercel deployment (nodejs runtime for API routes)
- Package.json: `npm run build` → `.next/` artifact

---

## Telephony Architecture

```
User calls +4923399255995 (Twilio)
  ↓
/api/twilio/voice (webhook answer)
  ├─ getContext() → extracts topic, userId
  ├─ prepareCall() → initialisiert Laufzeit-Kontext + ElevenLabs
  └─ returns TwiML with Gather/Say
      ↓
User speaks → Twilio transcribes
  ↓
/api/twilio/voice/process (user input handling)
  ├─ getScriptOrigin(topic, userId) → tracks script source
  ├─ getTopicScript() → resolves user-scoped script
  ├─ OpenAI Chat-Completions-Entscheidungslogik
  ├─ ElevenLabs voice synthesis
  ├─ POST to /api/calls/webhook → interim report
  └─ returns next TwiML
      ↓
[Call continues until hangup]
  ↓
/api/twilio/status (completion webhook)
  ├─ extracts userId from callback URL
  └─ POST to /api/calls/webhook → final report + recording
      ↓
/api/calls/webhook (report aggregation)
  ├─ storeCallReport(userId, phoneNumberId)
  └─ email to REPORT_TO_EMAIL (matthias.duic@...)
```

### Script Selection Logic

**Before Fix:** All users shared single global `scriptProfiles` cache → wrong scripts loaded.

**After Fix:** 
- `scriptProfilesByUser: Record<string, Partial<Record<Topic, ScriptConfig>>>`
- `getRuntimeCacheKey(userId)` returns userId or "global"
- `syncScripts(baseUrl, userId)` fetches via `/api/twilio/scripts?userId=<userId>`
- Each user's scripts isolated in per-user Map

**Fallback:** If user has no custom script, falls back to global scripts automatically.

---

## Maintenance Checklist

### Daily
- [ ] Monitor `/api/health` (production endpoint)
- [ ] Check database connection via Render console
- [ ] Review call logs in `/api/calls/webhook` responses

### Weekly
- [ ] Verify Twilio webhook logs (account.twilio.com)
- [ ] Check email delivery success (SMTP to strato.de)
- [ ] Review error rates in call reports

### Monthly
- [ ] Database backup verification (Render auto-backups)
- [ ] ElevenLabs quota check
- [ ] OpenAI API usage (Chat Completions)

### Security
- **Don't commit .env.local** (gitignore active)
- **Rotate credentials** if exposed:
  - BASIC_AUTH_PASSWORD
  - TWILIO_AUTH_TOKEN
  - OPENAI_API_KEY
  - ELEVENLABS_API_KEY
- **Monitor CRON_SECRET** usage in logs

---

## Deployment Process

### Step 1: Build & Test
```powershell
npm run build
```
Compiles TypeScript, bundles routes, no lingering errors required.

### Step 2: Validate Locally (optional)
```powershell
npm run dev
# Then curl http://localhost:3000/api/health
```

### Step 3: Deploy to Production
```powershell
npx vercel deploy --prod --yes
```
Vercel builds, deploys to alias URL, updates production.

### Step 4: Smoke Test
```powershell
python tools/e2e_api_check.py
python tools/e2e_campaign_call_flow.py
```
Confirms all endpoints alive and scoping correct.

---

## Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Script mismatch in campaign calls | Old global cache (pre-fix) | Redeploy with user-scoped caching |
| Unauthorized API errors | Missing internal header | Add `Authorization: Basic <base64(MDUIC:password)>` |
| Call fails to connect | Twilio webhook URL wrong | Verify `/api/twilio/voice` in Twilio console |
| Reports not emailed | SMTP credentials invalid | Test via `curl -X POST /api/calls/webhook` with valid userId |
| Script origin shows "global" | User has no custom script | OK—fallback is expected behavior |

---

## Rollback Plan

If deployment causes issues:

```powershell
# List recent deployments
vercel list

# Rollback to previous production
vercel promote <previous-deployment-id>

# Or redeploy from git
git checkout <stable-commit>
npm run build
npx vercel deploy --prod --yes
```

---

## Support Contact

**Matthias Duic**  
- Email: matthias.duic@agentur-duic-sprockhoevel.de
- Twilio Callback: +4915755806701 (inbound forward)
- Report Recipient: REPORT_TO_EMAIL in env

---

**Last Updated:** April 21, 2026  
**Version:** 1.0 (Production Release)
