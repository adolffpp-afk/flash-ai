# Flash's virus scanner: ClamAV with a small password-protected web front, so Flash can check
# every file people upload before it uses or stores it. Deployed on Railway from this folder
# (steps in docs/virus-scan-setup.md). Flash sends POST /scan with the file as the body and
# "Authorization: Bearer <SCANNER_KEY>"; GET /health says whether ClamAV is ready.
FROM clamav/clamav:stable

RUN apk add --no-cache nodejs

# Reload new virus definitions in place, so the scanner needs about half the memory.
ENV CLAMD_CONF_ConcurrentDatabaseReload=no

COPY server.mjs start.sh /scanner/
RUN chmod +x /scanner/start.sh

ENTRYPOINT ["/sbin/tini", "--", "/scanner/start.sh"]
