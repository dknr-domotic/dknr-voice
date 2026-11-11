# Speech to text for dknr-voice: wyoming-vosk with sentence templates (corrected / limited modes)
#
# The official image (rhasspy/wyoming-vosk) is still at wyoming-vosk 1.5.0. dknr-voice needs 1.6.0
# (partial transcripts while speaking, phonetic correction, number ranges, back references in "out"),
# only available on the master branch for now: the commit is pinned below.
FROM python:3.11-slim-bookworm

ARG WYOMING_VOSK_COMMIT=351be309dc89577005e833189de8393ddb82702d

LABEL org.opencontainers.image.authors="Jean-Christian Paul Denis" \
      org.opencontainers.image.source="https://github.com/dknr-domotic/dknr-voice" \
      org.opencontainers.image.title="DKNR Voice Vosk" \
      org.opencontainers.image.description="wyoming-vosk speech to text for DKNR Voice" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && pip3 install --no-cache-dir \
        "wyoming-vosk[limited] @ git+https://github.com/rhasspy/wyoming-vosk@${WYOMING_VOSK_COMMIT}" \
    && apt-get remove -y --purge git \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# models are downloaded in /data, sentence templates are read from /sentences (shared with dknr-voice)
# /sentences belongs to uid 1000 (node-red user of dknr-voice), which writes the sentence templates
RUN mkdir -p /data /sentences && chown 1000:1000 /sentences
VOLUME ["/data", "/sentences"]
EXPOSE 10300

ENTRYPOINT ["python3", "-m", "wyoming_vosk", "--uri", "tcp://0.0.0.0:10300", "--data-dir", "/data", "--sentences-dir", "/sentences", "--database-dir", "/data"]
CMD ["--language", "fr", "--preload-language", "fr", "--correct-sentences", "--limit-sentences", "--allow-unknown"]
