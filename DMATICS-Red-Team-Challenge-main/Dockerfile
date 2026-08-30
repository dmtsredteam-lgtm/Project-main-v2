FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DB_PATH=/app/data/leaderboard.db

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /app/data

EXPOSE 8000

# The container is healthy when the app answers, not when the process exists.
# `restart: unless-stopped` cannot help with a worker that is up but wedged.
HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"

# Sessions are signed client-side cookies, so 2 workers is fine — provided both
# workers sign with the SAME key. compose enforces SECRET_KEY, but a plain
# `docker run` does not, and app.py then falls back to a per-process random key:
# two workers, two keys, and a player silently logged out on roughly every
# second request. --preload imports the app once in the master and forks, so
# even the fallback key is shared. It is not a substitute for setting
# SECRET_KEY (restarts still reset it) — it is the difference between "sessions
# reset on restart" and "the game is unplayable".
CMD ["gunicorn", "--preload", "-w", "2", "--threads", "4", "-b", "0.0.0.0:8000", "app:app"]
