FROM python:3.12-slim

WORKDIR /app

# Install system deps for faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sync/ sync/
COPY run_sync.py .

CMD ["python", "run_sync.py"]
