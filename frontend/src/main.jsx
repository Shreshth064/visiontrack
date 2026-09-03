import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./style.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// ==================================================================
// Small formatting helpers
// ==================================================================

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

function formatTimestamp(isoString) {
  if (!isoString) return "—";
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

function shortId(id) {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function App() {
  // ================================================================
  // CAMERA STATE
  // ================================================================
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const processingRef = useRef(false);

  const [cameraRunning, setCameraRunning] = useState(false);
  const [processedImage, setProcessedImage] = useState(null);
  const [apiConnected, setApiConnected] = useState(false);

  const [analytics, setAnalytics] = useState({
    active_objects: 0,
    fps: 0,
    entered: 0,
    exited: 0,
    class_counts: {},
  });

  // Session id of the session currently being recorded on the backend
  // (set from the X-Session-Id response header of /api/process-frame).
  const [liveSessionId, setLiveSessionId] = useState(null);

  // Session id + summary most recently saved via /api/session/stop.
  const [lastSession, setLastSession] = useState(null);

  // ================================================================
  // SESSION HISTORY (MongoDB, via GET /api/sessions)
  // ================================================================
  const [sessionHistory, setSessionHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  const fetchSessionHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const response = await fetch(`${API_URL}/api/sessions?limit=10`);

      if (!response.ok) {
        throw new Error(`History request failed: ${response.status}`);
      }

      const data = await response.json();
      setSessionHistory(data);
    } catch (error) {
      console.error("Could not load session history:", error);
      setHistoryError("Could not load session history.");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessionHistory();
  }, [fetchSessionHistory]);

  // ================================================================
  // API HEALTH CHECK
  // ================================================================
  const checkApiHealth = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/health`);

      if (!response.ok) {
        throw new Error("API returned an error");
      }

      setApiConnected(true);
    } catch (error) {
      console.error("API health check failed:", error);
      setApiConnected(false);
    }
  }, []);

  useEffect(() => {
    checkApiHealth();
    const interval = setInterval(checkApiHealth, 5000);
    return () => clearInterval(interval);
  }, [checkApiHealth]);

  // ================================================================
  // START CAMERA
  // ================================================================
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setLastSession(null);
      setCameraRunning(true);
    } catch (error) {
      console.error("Could not start camera:", error);
      alert("Could not access the camera. Please allow camera permission.");
    }
  };

  // ================================================================
  // STOP CAMERA
  // ================================================================
  const stopCamera = async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraRunning(false);

    // Tell the backend to finalize and persist the session to MongoDB.
    try {
      const response = await fetch(`${API_URL}/api/session/stop`, { method: "POST" });

      if (!response.ok) {
        throw new Error("Failed to stop session");
      }

      const data = await response.json();

      if (data.session_id) {
        setLastSession(data);
        console.log("Session saved:", data.session_id);
        // Refresh the history panel so the just-finished session shows up.
        fetchSessionHistory();
      }
    } catch (error) {
      console.error("Could not stop backend session:", error);
    }

    setLiveSessionId(null);
    setProcessedImage(null);
    setAnalytics({ active_objects: 0, fps: 0, entered: 0, exited: 0, class_counts: {} });
  };

  // ================================================================
  // SEND FRAME TO BACKEND
  // ================================================================
  const processFrame = useCallback(async () => {
    if (!cameraRunning) return;
    if (processingRef.current) return;
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    processingRef.current = true;

    try {
      // 1. Copy the current camera frame to a canvas.
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 480;

      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, width, height);

      // 2. Convert canvas to a JPEG blob.
      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.75);
      });

      if (!blob) throw new Error("Could not create image blob");

      // 3. Build multipart form data.
      const formData = new FormData();
      formData.append("file", blob, "frame.jpg");

      // 4. Send the frame to the FastAPI backend (defined in the ML notebook).
      const response = await fetch(`${API_URL}/api/process-frame`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Frame processing failed: ${response.status}`);
      }

      // 5. Read analytics from response headers.
      const activeObjects = Number(response.headers.get("X-Active-Objects") || 0);
      const fps = Number(response.headers.get("X-FPS") || 0);
      const entered = Number(response.headers.get("X-Entered") || 0);
      const exited = Number(response.headers.get("X-Exited") || 0);
      const sessionId = response.headers.get("X-Session-Id");

      let classCounts = {};
      const classCountsHeader = response.headers.get("X-Class-Counts");

      if (classCountsHeader) {
        try {
          classCounts = JSON.parse(classCountsHeader);
        } catch (error) {
          console.error("Could not parse class counts:", error);
        }
      }

      setAnalytics({ active_objects: activeObjects, fps, entered, exited, class_counts: classCounts });

      if (sessionId) setLiveSessionId(sessionId);

      // 6. Read the annotated JPEG and display it.
      const imageBlob = await response.blob();
      const imageUrl = URL.createObjectURL(imageBlob);

      setProcessedImage((previousUrl) => {
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        return imageUrl;
      });

      setApiConnected(true);
    } catch (error) {
      console.error("Frame processing error:", error);
      setApiConnected(false);
    } finally {
      processingRef.current = false;
    }
  }, [cameraRunning]);

  // ================================================================
  // PROCESS FRAMES CONTINUOUSLY WHILE THE CAMERA IS RUNNING
  // ================================================================
  useEffect(() => {
    if (!cameraRunning) return;

    let stopped = false;

    const loop = async () => {
      if (stopped) return;
      await processFrame();
      // The processingRef guard prevents overlapping requests, so the real
      // rate is governed by backend inference speed, not this delay.
      setTimeout(loop, 50);
    };

    loop();

    return () => {
      stopped = true;
    };
  }, [cameraRunning, processFrame]);

  // Clean up the object URL for the processed frame on unmount.
  useEffect(() => {
    return () => {
      if (processedImage) URL.revokeObjectURL(processedImage);
    };
  }, [processedImage]);

  // ================================================================
  // RENDER
  // ================================================================
  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>VisionTrack</h1>
          <p>Real-Time Object Detection, Tracking &amp; Analytics</p>
        </div>

        <div className="api-status">
          <span className={apiConnected ? "status-dot connected" : "status-dot disconnected"} />
          <span>API: {apiConnected ? "Connected" : "Disconnected"}</span>
        </div>
      </header>

      <main className="dashboard">
        {/* ============================================================ */}
        {/* CAMERA PANEL */}
        {/* ============================================================ */}
        <section className="panel camera-panel">
          <div className="panel-header">
            <h2>Camera</h2>

            {!cameraRunning ? (
              <button className="primary-button" onClick={startCamera}>
                Start Camera
              </button>
            ) : (
              <button className="stop-button" onClick={stopCamera}>
                Stop Camera
              </button>
            )}
          </div>

          {/* Hidden camera source */}
          <video ref={videoRef} autoPlay muted playsInline style={{ display: "none" }} />

          {/* Hidden canvas used to capture frames */}
          <canvas ref={canvasRef} style={{ display: "none" }} />

          {/* Processed camera output */}
          <div className="camera-view">
            {processedImage ? (
              <img src={processedImage} alt="VisionTrack processed camera" className="processed-video" />
            ) : (
              <div className="camera-placeholder">
                <div className="camera-icon">◉</div>
                <p>{cameraRunning ? "Processing camera..." : "Camera is stopped"}</p>
              </div>
            )}
          </div>

          {/* Session information */}
          {cameraRunning && liveSessionId && (
            <div className="session-info">
              Recording session
              <span className="session-live-dot" />
              <span>{shortId(liveSessionId)}</span>
            </div>
          )}

          {!cameraRunning && lastSession && (
            <div className="session-info">
              Last session saved:
              <span>{shortId(lastSession.session_id)}</span>
              {" · "}
              {formatDuration(lastSession.duration_seconds)}
              {" · "}
              {lastSession.total_frames_processed} frames
            </div>
          )}
        </section>

        {/* ============================================================ */}
        {/* ANALYTICS PANEL */}
        {/* ============================================================ */}
        <section className="panel analytics-panel">
          <h2>Analytics</h2>

          <div className="metrics-grid">
            <div className="metric-card">
              <span>Active Objects</span>
              <strong>{analytics.active_objects}</strong>
            </div>

            <div className="metric-card">
              <span>FPS</span>
              <strong>{analytics.fps.toFixed(1)}</strong>
            </div>

            <div className="metric-card">
              <span>Entered</span>
              <strong>{analytics.entered}</strong>
            </div>

            <div className="metric-card">
              <span>Exited</span>
              <strong>{analytics.exited}</strong>
            </div>
          </div>

          <div className="objects-section">
            <h3>Detected Objects</h3>

            {Object.keys(analytics.class_counts).length === 0 ? (
              <p className="empty-state">No objects detected.</p>
            ) : (
              <div className="object-list">
                {Object.entries(analytics.class_counts).map(([className, count]) => (
                  <div className="object-row" key={className}>
                    <span>{className}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ============================================================ */}
        {/* SESSION HISTORY PANEL (persisted in MongoDB) */}
        {/* ============================================================ */}
        <section className="panel history-panel">
          <div className="panel-header">
            <h2>Session History</h2>
            <button className="secondary-button" onClick={fetchSessionHistory} disabled={historyLoading}>
              {historyLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {historyError && <p className="empty-state">{historyError}</p>}

          {!historyError && sessionHistory.length === 0 && !historyLoading && (
            <p className="empty-state">
              No saved sessions yet. Start and stop the camera to record one.
            </p>
          )}

          {sessionHistory.length > 0 && (
            <div className="history-table">
              <div className="history-row history-header-row">
                <span>Started</span>
                <span>Duration</span>
                <span>Frames</span>
                <span>Avg FPS</span>
                <span>Entered</span>
                <span>Exited</span>
              </div>

              {sessionHistory.map((session) => (
                <div className="history-row" key={session.session_id} title={session.session_id}>
                  <span>{formatTimestamp(session.started_at)}</span>
                  <span>{formatDuration(session.duration_seconds)}</span>
                  <span>{session.total_frames_processed}</span>
                  <span>{session.avg_fps}</span>
                  <span>{session.entered}</span>
                  <span>{session.exited}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
