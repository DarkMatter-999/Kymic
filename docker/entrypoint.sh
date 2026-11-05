#!/bin/sh
# Prepares the data volume, then runs the gateway as root so it can start each
# Pi worker as the unprivileged "agent" user. The gateway's own state and the
# gateway-private records are root-only; the worker only gets what it needs.
set -eu

: "${PI_AGENT_UID:=10001}"
: "${PI_AGENT_GID:=10001}"

mkdir -p /data/gateway/meta /data/agent/workspaces /data/agent/sessions /data/agent/home
chown root:root /data /data/gateway /data/gateway/meta
chmod 755 /data
chmod 700 /data/gateway /data/gateway/meta
# Parents are traversable but not writable by the worker, so it cannot swap a
# directory underneath the gateway.
chown root:root /data/agent /data/agent/workspaces /data/agent/sessions
chmod 711 /data/agent /data/agent/workspaces /data/agent/sessions
# chmod first: once the directory belongs to the agent, root (which keeps no
# CAP_FOWNER) can no longer change its mode.
chmod 700 /data/agent/home
chown -R -h "$PI_AGENT_UID:$PI_AGENT_GID" /data/agent/home

exec "$@"
