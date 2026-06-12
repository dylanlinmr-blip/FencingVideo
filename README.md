# FenceVision

## Project Overview
- **Name**: FenceVision
- **Goal**: Analyze fencing bouts with frame-accurate review, ROW support, tip trails, persistent touch tracking, and fencer-level history tracking.
- **Stack**: React + Vite + TailwindCSS frontend, Cloudflare Worker (Hono), Cloudflare D1 + R2.

## Production URL
- **Live App**: https://6f63fe90-8afc-40c2-82a8-6227bfa0d828.vip.gensparksite.com

## Completed Features
- Video upload for `.mp4/.webm/.mov` through `/api/bouts`
- Video playback + frame/time stepping controls, speed, scrubber, frame/time display
- Weapon selector per bout (foil/sabre/epee)
- ROW assistant logic for foil/sabre and simplified epee handling
- Tip trail mark mode with fading red/green overlays
- Persistent touch scoreboard/log with undo
- Bout library (open/delete, score/date/weapon shown)
- **Fencer tracker page**:
  - Aggregates every fencer entered on left/right side of bouts
  - Shows complete linked bout history per fencer
  - Shows bout count and most recent bout date per fencer
- **USA Fencing profile linking**:
  - Save USA Fencing member ID/profile URL per fencer
  - Sync recent public results into local history
  - Display recent synced event name/date/score summaries
- Cloudflare-native persistence:
  - **D1**: `bouts`, `touches`, `tip_marks`, `fencers`, `usafencing_results`, `calendar_blocks`
  - **R2**: uploaded video objects

## UI Routes
- `/` → Bouts library
- `/upload` → Upload bout
- `/fencers` → Fencer tracker + USA Fencing linking/sync
- `/fencers/:name` → Fencer detail page (full bout history + profile sync controls)
- `/analyzer/:id` → Main analysis view
- `/about` → Product info

## API Routes
- `GET /api/health`
- `POST /api/bouts` (multipart: `video`, `title`, `weapon`, `left_name`, `right_name`)
- `GET /api/bouts`
- `GET /api/bouts/:id`
- `DELETE /api/bouts/:id`
- `POST /api/bouts/:id/touches`
- `DELETE /api/touches/:id`
- `POST /api/bouts/:id/tip-marks`
- `DELETE /api/bouts/:id/tip-marks?fencer=left|right`
- `GET /api/fencers`
- `GET /api/fencers/:name`
- `POST /api/fencers/:name/usafencing-link`
- `POST /api/fencers/:name/usafencing-sync`
- `GET /api/usafencing/events`
- `GET /api/calendar/blocks`
- `POST /api/calendar/blocks`
- `DELETE /api/calendar/blocks/:id`
- `GET /uploads/:filename`

## Data Model
- `bouts(id, title, weapon, left_name, right_name, video_filename, created_at, left_score, right_score)`
- `touches(id, bout_id, video_time_seconds, scorer, row_verdict, note, created_at)`
- `tip_marks(id, bout_id, fencer, video_time_seconds, x_norm, y_norm, created_at)`
- `fencers(id, name, usafencing_member_id, usafencing_profile_url, created_at)`
- `usafencing_results(id, fencer_id, event_name, event_date, score_summary, source_url, created_at)`
- `calendar_blocks(id, title, start_time, end_time, location, notes, created_at)`

## User Guide
1. Upload a bout from **Upload** with left/right fencer names.
2. Open the bout in **Bouts** to analyze touches and tip marks.
3. Visit **Fencers** to view cumulative history per fencer.
4. Click **View Detail** for a dedicated fencer profile page.
5. In the detail view (or tracker card), add USA Fencing profile URL and click **Save Link**.
6. Click **Sync Recent Results** to pull latest public event/score summaries.

## Local Development
```bash
cd /home/user/webapp
npm run build
npm run dev
```
`npm run dev` runs `wrangler pages dev` with local D1/R2 bindings.

## Not Yet Implemented
- Automatic thumbnail extraction from uploaded video first frame
- Export/import package (JSON/CSV)
- Multi-user auth/permissions
- Fully structured USA Fencing API integration (current sync uses best-effort public HTML parsing)
- Automated CV-based tip detection

## Recommended Next Steps
1. Add fencer profile detail pages with filters by weapon/opponent/date range.
2. Add input validation + toast error states for all API failures.
3. Add export for fencer history and USA Fencing synced results.
4. Add test suite for Worker endpoints and parser quality.

## Deployment Status
- **Platform**: Genspark-hosted Cloudflare Worker + D1 + R2
- **Status**: ✅ Active
- **Last Updated**: 2026-06-12
