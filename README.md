# VisionTrack

Real-time object detection, tracking, and analytics. A React dashboard streams
webcam frames to a backend that runs a pretrained SSD MobileNet V2 detector +
ByteTrack tracker, returns annotated frames and live counts, and persists
finished sessions to MongoDB for later review.

**The entire ML pipeline and the API server live in one notebook:**
[`notebooks/visiontrack_ml.ipynb`](notebooks/visiontrack_ml.ipynb). There is
no separate backend `.py` file — Docker runs the notebook itself, headlessly,
as the live service. See [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) for
the full architecture, data model, and API contract.

## Project structure

```
visiontrack/
├── notebooks/
│   ├── visiontrack_ml.ipynb   # ML pipeline + FastAPI + MongoDB backend (single source of truth)
│   └── requirements.txt       # generated from the notebook's install cell + headless-exec tooling
├── frontend/
│   ├── src/
│   │   ├── main.jsx           # React dashboard: camera, live analytics, session history
│   │   └── style.css
│   ├── index.html
│   ├── package.json
│   └── .env.example
├── docker/
│   └── backend.Dockerfile     # executes the notebook headlessly as the API server
├── Dockerfile                 # builds the frontend (Vite → static → nginx)
├── docker-compose.yml         # mongo + backend + frontend
├── .env.example                # docker-compose configuration
└── docs/
    └── SYSTEM_DESIGN.md
```

## Quick start (Docker Compose)

Requires Docker and Docker Compose.

```bash
cp .env.example .env
docker compose up --build
```

This starts three containers:

| Service | URL | What it is |
|---|---|---|
| `frontend` | http://localhost:8080 | React dashboard (nginx, static build) |
| `backend`  | http://localhost:8000 | FastAPI service, run from the notebook |
| `mongo`    | localhost:27017        | Session storage |

Open **http://localhost:8080**, click **Start Camera**, grant camera
permission, and watch live detections + counts. Click **Stop Camera** to save
the session — it'll show up in the **Session History** panel, backed by
MongoDB.

> **First run will be slow.** The backend image installs TensorFlow +
> OpenCV, and on first request it downloads SSD MobileNet V2 from TF-Hub
> (a few hundred MB). Give the backend a minute or two before the frontend's
> "API: Connected" indicator turns green.

### Configuration

All of this lives in `.env` (copied from `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `MONGO_URI` | `mongodb://mongo:27017` | Mongo connection string used by the backend |
| `MONGO_DB` | `visiontrack` | Database name |
| `API_PORT` | `8000` | Port the backend listens on / is published on |
| `SNAPSHOT_INTERVAL_SECONDS` | `2.0` | Throttle for time-series snapshots written to Mongo |
| `VISIONTRACK_CONFIDENCE_THRESHOLD` | `0.5` | Detector confidence cutoff |
| `VISIONTRACK_TRACKER_FRAME_RATE` | `3.0` | ByteTrack's expected frame rate |
| `VISIONTRACK_LINE_Y` | `300` | Pixel y-coordinate of the entered/exited counting line |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:8080` | Origins the API accepts requests from |
| `VITE_API_URL` | `http://localhost:8000` | Backend URL baked into the frontend build (must be reachable from the *browser*) |
| `FRONTEND_PORT` | `8080` | Host port the frontend is published on |

## Local development (without Docker)

### Backend / ML notebook

```bash
cd notebooks
pip install -r requirements.txt
jupyter lab visiontrack_ml.ipynb
```

- Run all cells top-to-bottom (default `VISIONTRACK_MODE=notebook`) to walk
  through detection → tracking → analytics on a still image.
- To use your own webcam directly from Jupyter (bypassing the React app):
  set the environment variable `VISIONTRACK_MODE=webcam` before starting
  Jupyter, then run the notebook — Section 13 opens an OpenCV window.
- To run it as the live API server locally: start a local MongoDB
  (`docker run -p 27017:27017 mongo:7`), set
  `VISIONTRACK_MODE=api` (and optionally `MONGO_URI=mongodb://localhost:27017`),
  then either run the notebook's cells in Jupyter, or headlessly with:

  ```bash
  VISIONTRACK_MODE=api jupyter nbconvert --to notebook --execute \
    --ExecutePreprocessor.timeout=-1 \
    --ExecutePreprocessor.kernel_name=python3 \
    --output /tmp/executed.ipynb visiontrack_ml.ipynb
  ```

### Frontend

```bash
cd frontend
cp .env.example .env      # VITE_API_URL=http://localhost:8000
npm install
npm run dev
```

Opens the Vite dev server (default http://localhost:5173) with hot reload.

## Performance

The notebook is upfront about this in its own "Performance notes" section:
expect roughly **2–3 FPS on CPU** — SSD MobileNet V2 inference is the
bottleneck, not frame capture or the network hop. See
[`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md#8-known-limits--how-theyd-be-addressed-at-scale)
for what would change to go faster.

## Notes

- The ML model (SSD MobileNet V2) is pretrained on COCO — this project does
  not train a model from scratch. The contribution is the end-to-end system:
  detection → tracking → analytics → persisted session history, wired up
  with a working frontend, database, and container setup.
- `frontend/package-lock.json` pins exact dependency versions used during
  development; regenerate with `npm install` if you change `package.json`.
