# Market Compass — Handover & Operations Guide

## 1. What this is
A full-stack web application (no mobile app; nothing is published on App Store or Google Play).
- Framework: TanStack Start v1 (React 19, Vite 7, TypeScript), Tailwind CSS v4.
- Runtime: server functions and SSR run on Cloudflare Workers (workerd), not Node.
- Backend: Lovable Cloud (managed Postgres database, auth, storage). Schema lives in `supabase/migrations/` (apply in filename order).
- AI: Lovable AI Gateway (`LOVABLE_API_KEY`) for the AI Strategy Analyst chat.
- No Docker, Firebase or Google Cloud is used.

## 2. Requirements
- Node.js 20+ and bun (or npm).

## 3. Run locally
```sh
bun install
cp .env.example .env   # or create .env with the variables in section 5
bun run dev            # http://localhost:8080
bunx vitest run        # test suite
bun run build          # production build into dist/
```
ML command-line runner: `bun scripts/ml-cli.ts --synthetic` or `--csv file.csv`.

## 4. Backend setup (self-hosting outside Lovable)
1. Create a Postgres/Supabase project.
2. Run every file in `supabase/migrations/` in order (`supabase db push` or `psql -f`).
3. Set the environment variables below on your server/worker host.
4. Schedule a cron (every minute) calling `POST /api/public/forecast-evaluate` with header `Authorization: Bearer $LOVABLE_CRON_SECRET` (use any long random string you choose when self-hosting).
5. Replace `LOVABLE_API_KEY` usage in `src/lib/use/analyst/agent.server.ts` with your own OpenAI-compatible provider key if you leave Lovable.

## 5. Environment variables / API keys
| Name | Where it is used | Where to get it |
|---|---|---|
| SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (+ VITE_ copies) | DB client | Your database project settings |
| SUPABASE_SERVICE_ROLE_KEY | Server-only admin writes | Your database project settings (never in browser) |
| TWELVE_DATA_API_KEY | Forex + crypto candles (800 credits/day plan) | twelvedata.com dashboard |
| DATABENTO_API_KEY | Futures (currently delayed by plan) | databento.com portal |
| FINNHUB_API_KEY | Optional, currently unused by symbols | finnhub.io |
| OANDA_API_KEY | Not set; enables 13 forex/metal symbols | oanda.com → API access |
| LOVABLE_API_KEY | AI chat | Managed by Lovable |
| LOVABLE_CRON_SECRET | Authorizes background forecast worker | Managed by Lovable / self-chosen |

Key values are never stored in the code. The owner of each provider account (Twelve Data, Databento, Finnhub) already holds the keys; rotate them in those dashboards at handover.

## 6. Project layout
- `src/routes/` — pages (`/`, `/admin`, `/analyst`) and API routes (`api/`, `api/public/`).
- `src/components/use/` — UI panels.
- `src/lib/use/` — engines: data providers, forecast, reliability, Pine parser/executor/generator, pattern analyzer, universal strategy analysis, ML (`ml/`). Read `src/lib/use/AGENTS.md` first.
- `supabase/migrations/` — database schema.
- `src/assets/analyst-mark.jpg` — the only image asset (AI-generated, free to use).

## 7. Operating rules
- Signals require ≥55% confidence; otherwise NO SIGNAL / LOW CONFIDENCE.
- Reliability uses only chronological out-of-sample results and the frozen forecast ledger.
- Binance is blocked from the server region; Databento is delayed by plan.
