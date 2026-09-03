# VisionTrack — System Design

## 1. What this is

VisionTrack is a real-time object detection, tracking, and analytics
dashboard. A browser captures webcam frames, streams them to a backend for
inference, and displays the annotated video plus live counts. Finished
sessions are persisted so they can be reviewed later.

**Deliberate constraint:** all ML/CV code and the API layer live in a single
Jupyter notebook (`notebooks/visiontrack_ml.ipynb`) — there is no
hand-maintained backend `.py` file. This keeps the ML pipeline as one
reviewable, runnable artifact (useful for demos/interviews) while still
producing a genuinely deployable service, by executing that notebook
headlessly inside Docker.

## 2. Architecture

```
┌──────────────────┐        HTTPS/JSON, multipart JPEG        ┌───────────────────────────┐
│   React frontend │ ───────────────────────────────────────▶ │  FastAPI (in the notebook) │
│  (nginx, static)  │ ◀─────────────────────────────────────── │  Section 15/16              │
│                   │   annotated JPEG + X-* analytics headers │                             │
└──────────────────┘                                           │  detect() → track() →      │
   getUserMedia()                                               │  count() → line-cross →    │
   canvas → JPEG                                                 │  annotate() → SessionMgr   │
   every ~50ms while                                             └───────────┬────────────────┘
   camera is running                                                        │ pymongo
                                                                              ▼
                                                                    ┌──────────────────┐
                                                                    │     MongoDB      │
                                                                    │ sessions          │
                                                                    │ session_snapshots │
                                                                    └──────────────────┘
```

**Why the browser sends individual JPEG frames over HTTP instead of a video
stream (e.g. WebRTC):** it's the simplest thing that works for a
demo/portfolio-scale project — one stateless-looking POST per frame, easy to
reason about, easy to rate-limit/backpressure (the frontend never sends a new
frame until the previous one's response comes back). Section 6 below covers
what would change for real production video throughput.

## 3. Request flow (happy path)

1. User clicks **Start Camera** → browser `getUserMedia()` grabs the webcam
   stream and starts a capture loop.
2. Every ~50ms (throttled by the previous request finishing), the frontend
   draws the current video frame to a hidden `<canvas>`, exports it as a JPEG
   blob, and `POST`s it to `/api/process-frame` as multipart form data.
3. The backend decodes the JPEG, runs it through the notebook's
   `process_frame()` pipeline (SSD MobileNet V2 → confidence filter → pixel
   boxes → ByteTrack → counting → line-crossing → annotation), and:
   - lazily starts an in-memory `SessionManager` session on the *first* frame
     of a run (`session_manager.ensure_started()`), if one isn't already open;
   - updates in-memory aggregates (frame count, FPS sum, peak concurrent
     objects, distinct tracker IDs seen per class);
   - **throttles** MongoDB writes: only every `SNAPSHOT_INTERVAL_SECONDS`
     (default 2s) does it write a lightweight snapshot document, instead of
     on every frame.
4. The backend returns the annotated JPEG as the response body, with the
   live counters in `X-Active-Objects` / `X-FPS` / `X-Entered` / `X-Exited` /
   `X-Class-Counts` / `X-Session-Id` response headers.
5. The frontend swaps in the new image, updates the metrics cards, and
   repeats from step 2.
6. User clicks **Stop Camera** → browser stops the media stream and calls
   `POST /api/session/stop`. The backend finalizes the in-memory session into
   a summary document (duration, avg FPS, peak concurrent objects, distinct
   objects seen per class, entered/exited totals) and inserts it into the
   `sessions` collection. The frontend shows "Last session saved" and
   refreshes its **Session History** panel via `GET /api/sessions`.

## 4. Data model (MongoDB)

Database: `visiontrack` (configurable via `MONGO_DB`).

### `sessions`
One document per finished camera session.

```json
{
  "_id": "1687753a-2c72-48eb-a440-4e97c83fcec5",
  "started_at": "2026-09-03T22:13:57.789Z",
  "ended_at": "2026-09-03T22:14:42.114Z",
  "duration_seconds": 44.3,
  "total_frames_processed": 812,
  "avg_fps": 2.6,
  "peak_active_objects": 5,
  "entered": 3,
  "exited": 2,
  "distinct_object_counts": { "person": 4, "car": 1 }
}
```

`distinct_object_counts` counts **unique ByteTrack IDs seen per class over
the whole session** — a more meaningful "how many different things did we
see" metric than whatever happened to be on-screen in the final frame.

### `session_snapshots`
Time-series points for charting a session's history, written at most once
every `SNAPSHOT_INTERVAL_SECONDS`.

```json
{
  "session_id": "1687753a-2c72-48eb-a440-4e97c83fcec5",
  "timestamp": "2026-09-03T22:14:10.001Z",
  "active_objects": 3,
  "fps": 2.7,
  "entered": 2,
  "exited": 1
}
```

**Why not persist every frame?** Even at a modest 5–10 FPS, that's tens of
thousands of writes for a short session with no analytical benefit over a
throttled series — it would make Mongo the bottleneck instead of inference.
Indexing `sessions.started_at` (descending) and `session_snapshots.session_id`
supports the two access patterns the API actually needs: "recent sessions"
and "this session's timeline."

## 5. API contract

| Method | Path | Body / Params | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{status, source, mongo_connected, active_session}` |
| POST | `/api/process-frame` | multipart `file` (JPEG) | annotated JPEG body + `X-Active-Objects`, `X-FPS`, `X-Entered`, `X-Exited`, `X-Class-Counts`, `X-Session-Id` headers |
| POST | `/api/session/stop` | — | session summary JSON, or `{session_id: null}` if none was active |
| GET | `/api/sessions?limit=20` | query `limit` | array of session summaries, most recent first |
| GET | `/api/sessions/{id}` | — | session summary + `snapshots[]` time series |
| DELETE | `/api/sessions/{id}` | — | `{deleted: id}` |

Analytics are returned as **response headers, not a JSON body**, alongside
the binary JPEG — this avoids a second round trip per frame (e.g. a
multipart response or a parallel JSON call) at the cost of headers being a
slightly awkward place to carry structured data. `X-Class-Counts` is a small
JSON blob of `{"person": 2, "car": 1}` — headers have no hard size limit
that matters here since class counts are tiny.

## 6. Deployment topology (docker-compose)

Three services:

- **`mongo`** — official `mongo:7` image, persistent named volume
  (`mongo_data`), healthcheck gates the backend's startup.
- **`backend`** — built from `docker/backend.Dockerfile`. Installs
  `notebooks/requirements.txt`, registers a Jupyter kernel, and runs
  `jupyter nbconvert --execute notebooks/visiontrack_ml.ipynb` with
  `VISIONTRACK_MODE=api`. The notebook's own last cell starts Uvicorn and
  blocks forever — that's the container's long-running process.
- **`frontend`** — the provided multi-stage `Dockerfile`: Vite build → static
  files served by `nginx:alpine`. `VITE_API_URL` is a **build arg**, because
  Vite inlines env vars at build time; it cannot be changed by setting a
  runtime environment variable on the nginx container.

All three are wired together in `docker-compose.yml`, configured through a
root `.env` file (see `.env.example`).

## 7. Config & security notes

- **CORS** is restricted via `CORS_ORIGINS` (comma-separated) rather than
  left as `allow_origins=["*"]`, since the API accepts uploads and is meant
  to be called from a known frontend origin.
- **No authentication** in this MVP — anyone who can reach the API can drive
  the camera pipeline and read session history. For a real deployment: put
  the API behind auth (e.g. a reverse proxy with OIDC, or a JWT check in
  FastAPI), and consider per-user session ownership in the `sessions`
  documents instead of one global "current session."
- **Upload validation** is minimal (non-empty, decodable as an image via
  OpenCV). A production version should cap upload size and content-type at
  the reverse proxy / FastAPI layer to avoid oversized payloads.
- **Secrets**: none required for local Mongo. For a hosted MongoDB (e.g.
  Atlas), `MONGO_URI` would carry credentials — keep it in `.env` (already
  git-ignored) or a real secrets manager, never committed.

## 8. Known limits & how they'd be addressed at scale

The notebook's own performance-notes section states the honest baseline:
**~2–3 FPS on CPU**, because SSD MobileNet V2 inference dominates latency,
not frame resizing or I/O. Given that constraint, the design choices above
(threadpool offloading for inference, throttled Mongo writes) optimize
*around* that bottleneck rather than pretending it doesn't exist. If this
needed to serve more than one camera / more FPS:

- **Horizontal scaling**: the backend is *mostly* stateless except for the
  in-memory `SessionManager` (one active session per process). To run
  multiple backend replicas behind a load balancer, session state would need
  to move out of process memory — e.g. into Redis, or by making
  `/api/process-frame` accept an explicit `session_id` from the client
  instead of implying "the one open session," with affinity/routing handled
  by the frontend or a sticky-session load balancer.
- **Faster inference**: swap SSD MobileNet V2 for a lighter/quantized model
  (TFLite), run on GPU, or skip frames (detect every Nth frame, track on the
  rest) — all called out already in the notebook's performance-notes
  section.
- **Decoupled ingestion**: for many concurrent cameras, put a queue (e.g.
  Kafka/Redis Streams) between frame ingestion and inference workers instead
  of synchronous request/response per frame, so bursts don't back up HTTP
  connections.
- **True video streaming**: WebRTC/RTSP ingestion instead of one HTTP POST
  per JPEG would cut per-frame overhead, at the cost of a materially more
  complex media pipeline — a reasonable v2, not needed for this project's
  scope.

## 9. Why keep the ML code in one notebook at all?

This is a project-scoping decision, not a general recommendation: it keeps
the entire "how does the detector/tracker/analytics actually work"
explanation (markdown + code, runnable top-to-bottom) as one artifact that's
easy to read, present, and modify without hunting across files — while
`docker/backend.Dockerfile` proves it's not *just* a notebook, by actually
executing it as the real backend. In a larger production codebase, this code
would normally be extracted into versioned modules with proper tests; this
project intentionally keeps that tradeoff visible rather than hiding it.
