FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git systemd python3 openssl \
    && rm -rf /var/lib/apt/lists/*
