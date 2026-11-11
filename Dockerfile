
# Use fix Node-red docker release
FROM nodered/node-red:5.0

# Switch to root user
USER root

# Set environment variables
ENV DKNR_USERNAME=admin \
      DKNR_PASSWORD=admin \
      DKNR_SECRET=dkvoice \
      DKNR_REPOSITORY=https://github.com/dknr-domotic/dknr-voice \
      NODE_RED_ENABLE_PROJECTS=true \
      TZ=Europe/Paris

# Image label
LABEL org.opencontainers.image.authors="Jean-Christian Paul Denis" \
      org.opencontainers.image.source="https://github.com/dknr-domotic/dknr-voice" \
      org.opencontainers.image.title="DKNR Voice" \
      org.opencontainers.image.description="DKNR local voice control (ESPHome voice devices, Vosk, Piper) with web UI" \
      org.opencontainers.image.licenses="AGPL-3.0"

# Set system timezone
RUN echo "$TZ" > /etc/timezone

# Prepare Node-Red structure, and the sentences folder shared with wyoming-vosk
RUN mkdir -p /data/projects/dknr-voice /sentences

# Clone repository
RUN git clone ${DKNR_REPOSITORY} /data/projects/dknr-voice

# Fix ownership
RUN chown -R node-red:node-red /data /sentences

# Switch to node-red user
USER node-red

# Set working diretory for container starting script
WORKDIR /data

# Add container starting script
ADD docker-entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
