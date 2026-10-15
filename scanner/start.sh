#!/bin/sh
# ClamAV's own start-up (downloads virus definitions on first start, then runs clamd and the
# updater) in the background, and the web front in the foreground.
set -eu
/bin/sh /init &
exec node /scanner/server.mjs
