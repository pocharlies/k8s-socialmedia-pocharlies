"""MinIO uploader for Telegram media — used by history.py + realtime.py + backfill.

Bucket `socialmedia-media` is shared across WA + TG + IG. Object keys follow
`attachments/{message_id}/{ts}.{ext}` so they don't collide. We upload bytes
directly from BytesIO (no disk write).
"""
from __future__ import annotations

import io
import logging
import os
import time
from typing import Optional

from minio import Minio

logger = logging.getLogger(__name__)

MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
MINIO_USE_SSL = os.environ.get("MINIO_USE_SSL", "true").lower() == "true"
MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "socialmedia-media")
# Use cert_check=False to accept the cluster's self-signed CA. The CA file is
# at /certs/ca.crt inside the container; for a stricter setup use
# `Minio(..., http_client=urllib3.PoolManager(ca_certs="/certs/ca.crt"))`.
_CERT_CHECK = os.environ.get("MINIO_CERT_CHECK", "false").lower() == "true"

_client: Optional[Minio] = None


def _get_client() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            MINIO_ENDPOINT,
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            secure=MINIO_USE_SSL,
            cert_check=_CERT_CHECK,
        )
    return _client


def ensure_bucket() -> None:
    c = _get_client()
    if not c.bucket_exists(MINIO_BUCKET):
        c.make_bucket(MINIO_BUCKET)
        logger.info(f"Created MinIO bucket: {MINIO_BUCKET}")


_EXT_BY_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "application/pdf": "pdf",
}


def pick_ext(mime_type: Optional[str], file_name: Optional[str]) -> str:
    if file_name and "." in file_name:
        return file_name.rsplit(".", 1)[-1][:6].lower()
    if mime_type and mime_type in _EXT_BY_MIME:
        return _EXT_BY_MIME[mime_type]
    if mime_type and mime_type.startswith("image/"):
        return "bin"
    return "bin"


def upload_media(
    message_id: int,
    data: bytes,
    mime_type: Optional[str],
    file_name: Optional[str],
) -> tuple[str, int]:
    """Upload bytes to MinIO and return (storage_key, size). Storage key goes
    into attachments.file_url; the dashboard streams via /api/messages/media-blob/{id}."""
    c = _get_client()
    ext = pick_ext(mime_type, file_name)
    storage_key = f"attachments/{message_id}/{int(time.time() * 1000)}.{ext}"
    buf = io.BytesIO(data)
    metadata = {}
    if mime_type:
        metadata["Content-Type"] = mime_type
    c.put_object(
        MINIO_BUCKET,
        storage_key,
        buf,
        length=len(data),
        content_type=mime_type or "application/octet-stream",
        metadata=metadata or None,
    )
    return storage_key, len(data)
