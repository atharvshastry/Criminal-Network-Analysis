# AGENTS.md

SIH 26189 — AI-Powered Criminal Network Analysis System. Small MVP starter with two parts: FastAPI backend (`backend/`) and React/Vite frontend (`frontend/`).

## Backend = static JSON, not a database

Despite the `docker-compose.yml` (Postgres + Neo4j), **no database is connected yet**. The backend reads mock JSON files from the repo-root `data/` folder at request time:

- `backend/app/main.py:7` resolves `DATA = BASE / "data"` where `BASE` is `parents[2]` (i.e. the repo root `data/`, not `backend/data`).
- Every endpoint re-loads the JSON on each call — editing `data/*.json` and refreshing is the whole dev loop.
- Files: `cases.json`, `entities.json`, `network.json`, `alerts.json`.

## Data contracts (frontend depends on these)

- `network.json` = `{ nodes, edges }`. Nodes use `label` (not `name`), `type`, `community`, `centrality`. Edges use `source`/`target` (NOT `from`/`to`).
- Confidence/score fields are `0..1` floats; the frontend displays them as `*100` (e.g. `Math.round(a.score*100)`).
- Entities: `{ id, name, type, confidence, community, centrality }`. Alerts: `{ id, title, entity_id, score, reasons[], severity }`. Cases: `{ id, title, status, priority, entities, relationships, alerts }`.
- Backend uses plain `json.load` (no models), and ID-based endpoints (`/api/cases/{id}` etc.) return 404 if the ID is absent.

## Commands

Backend (from `backend/`):
```
python -m venv .venv            # already done typically
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload   # http://127.0.0.1:8000, Swagger at /docs
```

Frontend (from `frontend/`):
```
npm install
npm run dev                     # http://localhost:5173
```

- No test suite, no linter, no formatter configured anywhere. `frontend` build script is just `vite` (no production build config).
- CORS only allows `http://localhost:5173` (`main.py:21`). Both servers must run for the frontend to work.

## Frontend quirks

- Plain React + React Router, ESM (`"type": "module"`). Uses `@vitejs/plugin-react` and `cytoscape` for the graph.
- Detail routes parse the ID via `window.location.pathname.split("/")` with hardcoded fallbacks (`CASE-001`, `P001`) rather than `useParams` (`App.jsx:103,146`).
- `NetworkGraph.jsx` builds cytoscape elements directly from the raw `network.json` shape (`data: n`, `data: e`).

## Constraints

- **Do not use real criminal/police personal data.** Keep the demo fully synthetic and label AI results as investigative leads, not proof of criminality. AI must not auto-label anyone as guilty — expose score, reason, supporting relationships, source, and confidence.