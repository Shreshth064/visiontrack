# VisionTrack backend image.
#
# There is deliberately no hand-written backend .py file: this image installs
# the dependencies listed in notebooks/requirements.txt (which mirrors the
# notebook's own install cell) and then runs the notebook itself headlessly
# with `jupyter nbconvert --execute`. The notebook's own Section 16 detects
# VISIONTRACK_MODE=api (set below) and starts the FastAPI + MongoDB service,
# which then runs for the lifetime of the container.

FROM python:3.11-slim

# System libraries OpenCV needs at runtime, plus curl for the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY notebooks/requirements.txt ./notebooks/requirements.txt
RUN pip install --no-cache-dir -r notebooks/requirements.txt

# Register a "python3" Jupyter kernel spec so nbconvert can execute the
# notebook (the notebook's metadata pins kernelspec.name = "python3").
RUN python -m ipykernel install --name python3 --sys-prefix

COPY notebooks ./notebooks

ENV VISIONTRACK_MODE=api \
    PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# --ExecutePreprocessor.timeout=-1 : the API server cell runs forever by
# design (await server.serve()), so there is no per-cell timeout.
CMD ["jupyter", "nbconvert", "--to", "notebook", "--execute", \
     "--ExecutePreprocessor.timeout=-1", \
     "--ExecutePreprocessor.kernel_name=python3", \
     "--output", "/tmp/executed_visiontrack_ml.ipynb", \
     "notebooks/visiontrack_ml.ipynb"]
