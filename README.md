
# SIH 26189 — AI-Powered Criminal Network Analysis System

This is a deliberately small, open-source-first starter for the SIH 2026 problem statement.

## MVP architecture

React (frontend)
        |
      REST/JSON
        |
FastAPI (backend)
   |             |
Mock JSON     mongoDB + Neo4j (next phase)
   |
AI/ML services (next phase)

## Run

### Backend
```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload
```

Backend: http://127.0.0.1:8000
Swagger: http://127.0.0.1:8000/docs

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend: http://localhost:5173

## What is already implemented

- Dashboard
- Cases list
- Case detail
- Interactive network graph
- Entity profile
- Alerts
- Consistent JSON contracts
- FastAPI REST endpoints
- Synthetic data only

## Important

Do not use real criminal/police personal data in the demo. Use synthetic data and clearly label AI results as investigative leads, not proof of criminality.
