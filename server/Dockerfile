FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    AIUSAGE_HOST=0.0.0.0 \
    AIUSAGE_PORT=8787 \
    AIUSAGE_DATA_DIR=/data

WORKDIR /app
COPY aiusage ./aiusage

RUN useradd --system --uid 10001 aiusage && mkdir -p /data && chown aiusage /data
USER aiusage
VOLUME ["/data"]
EXPOSE 8787

CMD ["python", "-m", "aiusage"]
