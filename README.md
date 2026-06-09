# FenceVision

## Project Overview
- **Name**: FenceVision
- **Goal**: Analyze fencing bouts with synchronized video playback, right-of-way support, tip trajectory marking, and persistent scoring history.
- **Stack**: React + Vite + TailwindCSS (frontend), Express + SQLite + multer (backend)

## Completed Features
- Upload MP4/WEBM/MOV bouts with metadata (title, weapon, fencer names)
- Persistent SQLite storage for bouts, touches, tip marks, and running score
- Analyzer with frame/time stepping, speed control (0.1x–2x), timeline scrubber, frame counter
- Weapon-aware logic: Foil/Sabre ROW assistant + Épée touch mode with optional double-touch toggle
- Tip trail marking on canvas overlay (left=red, right=green), fade-time control, clear-by-fencer
- Touch logging with scorer, timestamp, weapon context, verdict, optional notes, undo last touch
- Bout library with cards, embedded video preview, score, weapon badge, created date, open/delete
- Empty-state UI for clean first use

## Functional Routes (UI)
- `/` → Bout library page
- `/upload` → Upload page
- `/analyzer/:id` → Main analysis workspace
- `/about` → Product summary

## API Endpoints
- `POST /api/bouts` (multipart: video + metadata)
- `GET /api/bouts`
- `GET /api/bouts/:id`
- `DELETE /api/bouts/:id`
- `POST /api/bouts/:id/touches`
- `DELETE /api/touches/:id`
- `POST /api/bouts/:id/tip-marks` (batch)
- `DELETE /api/bouts/:id/tip-marks?fencer=left|right`
- `GET /uploads/:filename`

## Data Architecture
### SQLite tables
- `bouts(id, title, weapon, left_name, right_name, video_filename, created_at, left_score, right_score)`
- `touches(id, bout_id, video_time_seconds, scorer, row_verdict, note, created_at)`
- `tip_marks(id, bout_id, fencer, video_time_seconds, x_norm, y_norm, created_at)`

### Storage
- SQLite file: `data/fencevision.db`
- Video files: `uploads/`

## Setup
```bash
cd /home/user/webapp
npm install
npm run dev
```
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001`

## User Guide
1. Go to **Upload** and upload a bout video with metadata.
2. Open the bout from **Bouts**.
3. Use transport controls under the video to inspect frame-by-frame.
4. In **ROW Assistant**, set decisions and press **Record Touch**.
5. In **Tip Trail**, enable **Mark Tip mode** and click tip positions over time.
6. In **Touches**, review score/log or undo the last touch.

## Not Yet Implemented
- Automatic video thumbnail extraction to still image files
- Multi-user auth and role permissions
- Export/import of full bout analysis packages
- Advanced machine vision auto-tip detection

## Recommended Next Steps
1. Add true step wizard Back/Next UI for ROW with persistent per-touch draft state.
2. Add per-bout notes persistence in database.
3. Add CSV/JSON export for touches + tip marks.
4. Add unit tests for ROW decision logic and API validation.

## Deployment Status
- **Platform**: Local full-stack dev runtime (Vite + Express)
- **Status**: ✅ Running in sandbox
- **Last Updated**: 2026-06-09
