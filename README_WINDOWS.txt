Rise of Agon PvP Finder (Windows-friendly v5)

Audio:
Put these in ./audio:
- notify.wav
- df_narrator_victory.wav
- df_narrator_defeat.wav

Run:
1) Install Node.js (LTS recommended): https://nodejs.org/
2) Open PowerShell in this folder
3) npm install
4) npm start
5) Open http://localhost:3000


Deploy (GitHub / web host)
- Commit this folder to GitHub.
- Set environment variable JWT_SECRET to a strong random string.
- Host must run `npm install` then `npm start`.
- App binds to process.env.PORT automatically.
- NOTE: db.json is local file storage (single instance). For real hosting, move to a database.


Admin
- Set env var ADMIN_USERNAMES to a comma-separated list (case-insensitive), e.g. "Squanto,Fowler".
- Admin tools include: announcements, reset ratings, delete fights, wipe notifications, ban users.
- IP viewing/banning is not included.


=== v10 Postgres (Render) Setup ===

1) Create a Render Postgres database
- Render Dashboard -> New -> PostgreSQL
- Create it in the same region as your web service.

2) Set env vars on your Render Web Service
- DATABASE_URL = (copy the INTERNAL Database URL from the Postgres page)
- JWT_SECRET = a long random string
- ADMIN_USERNAMES = optional, e.g. Squanto,Fowler
- NODE_ENV = production (optional)

3) Deploy
- Push this repo to GitHub
- In Render Web Service:
  Build command: npm install
  Start command: npm start

4) Verify
- Open your site
- Login/Register works
- Create/Accept fights works
- Match history persists in Postgres

Notes:
- This version no longer uses db.json at all.
- If you previously had db.json data you want migrated, ask for a migration script.


AUDIO FILES:
Put these .wav files into the /audio folder:
- notify.wav
- chat.wav
- df_narrator_victory.wav
- df_narrator_defeat.wav

They are not included in the zip.
