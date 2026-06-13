"""Docker dashboard backend.

Reads container info from the Docker Engine API (via the mounted
/var/run/docker.sock) and serves a small JSON API plus the dashboard page.

Customization is done entirely through Docker labels on your containers:

    dashboard.name   -> display name (defaults to the container name)
    dashboard.url    -> full link to open (overrides auto port detection)
    dashboard.port   -> which published port to link to (if several)
    dashboard.icon   -> a single emoji / short text shown on the tile
    dashboard.group  -> optional group/category name
    dashboard.hide   -> "true" to hide the container from the dashboard

No labels are required: by default every container is shown and the link
is built from its first published port.
"""

import os

import docker
from flask import Flask, jsonify, render_template

app = Flask(__name__)

# The dashboard's own container should not link to itself.
SELF_CONTAINER = os.environ.get("HOSTNAME", "")
# Link scheme used when building http://<host>:<port> automatically.
LINK_SCHEME = os.environ.get("LINK_SCHEME", "http")


def _client():
    """Create a Docker client from the environment / mounted socket."""
    return docker.from_env()


def _truthy(value):
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _published_ports(container):
    """Return a sorted list of host ports published by the container."""
    ports = set()
    port_map = (container.attrs.get("NetworkSettings", {}) or {}).get("Ports", {}) or {}
    for _container_port, bindings in port_map.items():
        for binding in bindings or []:
            host_port = binding.get("HostPort")
            if host_port:
                ports.add(int(host_port))
    return sorted(ports)


def _serialize(container):
    labels = container.labels or {}
    if _truthy(labels.get("dashboard.hide")):
        return None

    ports = _published_ports(container)

    # Decide which port the "open" button should target.
    preferred = labels.get("dashboard.port")
    link_port = None
    if preferred and preferred.isdigit() and int(preferred) in ports:
        link_port = int(preferred)
    elif ports:
        link_port = ports[0]

    state = container.attrs.get("State", {}) or {}

    return {
        "id": container.short_id,
        "name": labels.get("dashboard.name") or container.name,
        "raw_name": container.name,
        "icon": labels.get("dashboard.icon", ""),
        "group": labels.get("dashboard.group", ""),
        "status": container.status,  # running / exited / paused / restarting ...
        "health": (state.get("Health", {}) or {}).get("Status", ""),
        "image": (container.image.tags[0] if container.image.tags else container.short_id),
        "ports": ports,
        "link_port": link_port,
        "url_override": labels.get("dashboard.url", ""),
        "is_self": container.id.startswith(SELF_CONTAINER) and bool(SELF_CONTAINER),
        "scheme": LINK_SCHEME,
    }


@app.route("/api/containers")
def api_containers():
    try:
        client = _client()
        containers = client.containers.list(all=True)
    except Exception as exc:  # noqa: BLE001 - surface any docker error to the UI
        return jsonify({"error": str(exc)}), 500

    items = [c for c in (_serialize(c) for c in containers) if c is not None]
    # Running first, then alphabetical by display name.
    items.sort(key=lambda c: (c["status"] != "running", c["name"].lower()))
    return jsonify({"containers": items})


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8910"))
    app.run(host="0.0.0.0", port=port)
