FROM python:3.12-slim

WORKDIR /app

COPY connectors/telegram-sync/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY connectors/telegram-sync/sync/ sync/
COPY connectors/telegram-sync/run_sync.py .

CMD ["python", "run_sync.py"]
