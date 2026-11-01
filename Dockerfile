FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080 \
    BIND=0.0.0.0

RUN addgroup -g 1000 quiz \
    && adduser -D -u 1000 -G quiz quiz \
    && mkdir -p /app /data \
    && chown quiz:quiz /data

WORKDIR /app
COPY server.py ./
COPY content/ ./content/
COPY public/ ./public/

USER quiz:quiz
EXPOSE 8080
CMD ["python", "server.py"]
