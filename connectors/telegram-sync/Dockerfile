FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sync/ sync/
COPY run_sync.py .

CMD ["python", "run_sync.py"]
