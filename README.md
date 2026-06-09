# FenceVision

## Project Overview
- **Name**: FenceVision
- **Goal**: Analyze fencing bouts with frame-accurate review, ROW support, tip trails, and persistent touch tracking.
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
- Cloudflare-native persistence:
  - **D1**: bouts, touches, tip_marks
  - **R2**: uploaded video objects

## UI Routes
- `/` → Bouts library
- `/upload` → Upload bout
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
- `GET /uploads/:filename`

## Data Model
- `bouts(id, title, weapon, left_name, right_name, video_filename, created_at, left_score, right_score)`
- `touches(id, bout_id, video_time_seconds, scorer, row_verdict, note, created_at)`
- `tip_marks(id, bout_id, fencer, video_time_seconds, x_norm, y_norm, created_at)`

## Local Development
```bash
cd /home/user/webapp
npm install
npm run build
npm run dev
```
`npm run dev` runs `wrangler pages dev` with local D1/R2 bindings.

## Not Yet Implemented
- Automatic thumbnail extraction from uploaded video first frame
- Export/import package (JSON/CSV)
- Multi-user auth/permissions
- Automated CV-based tip detection

## Recommended Next Steps
1. Add true step-by-step ROW wizard UI (Back/Next state machine).
2. Add input validation + toast error states for all API failures.
3. Add export for touches/tip marks and per-bout notes persistence.
4. Add test suite for ROW logic and Worker endpoints.

## Deployment Status
- **Platform**: Genspark-hosted Cloudflare Worker + D1 + R2
- **Status**: ✅ Active
- **Last Updated**: 2026-06-09
