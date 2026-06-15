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
import socket
import threading
import time
from collections import deque
from datetime import datetime, timezone

import docker
from flask import Flask, jsonify, render_template

app = Flask(__name__)

# The dashboard's own container should not link to itself.
SELF_CONTAINER = os.environ.get("HOSTNAME", "")
# Link scheme used when building http://<host>:<port> automatically.
LINK_SCHEME = os.environ.get("LINK_SCHEME", "http")


_docker_client = None


def _client():
    """Return a shared Docker client (created once, reused across requests).

    Creating a new client per request leaks connections/file descriptors and
    slowly drives up system load, so we cache a single instance.
    """
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


def _reset_client():
    """Drop the cached client so the next call reconnects (after an error)."""
    global _docker_client
    try:
        if _docker_client is not None:
            _docker_client.close()
    except Exception:  # noqa: BLE001
        pass
    _docker_client = None


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


def _uptime_seconds(state):
    """Seconds since the container started, or None if not running."""
    started = state.get("StartedAt")
    if not started or started.startswith("0001-01-01"):
        return None
    # Docker returns RFC3339 with nanoseconds, e.g. 2026-06-15T20:00:00.123456789Z.
    # datetime can't parse 9 fractional digits, so trim to microseconds.
    txt = started.replace("Z", "+00:00")
    if "." in txt:
        head, frac = txt.split(".", 1)
        # frac looks like "123456789+00:00"
        digits = frac[:9]
        tz = frac[len(digits):] if len(frac) > 9 else ""
        # keep at most 6 fractional digits
        num = "".join(ch for ch in digits if ch.isdigit())[:6]
        txt = f"{head}.{num}{tz}" if num else f"{head}{tz}"
    try:
        start_dt = datetime.fromisoformat(txt)
    except ValueError:
        return None
    if start_dt.tzinfo is None:
        start_dt = start_dt.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - start_dt
    return max(0, int(delta.total_seconds()))


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
        "uptime": _uptime_seconds(state) if container.status == "running" else None,
        "health": (state.get("Health", {}) or {}).get("Status", ""),
        "image": (container.image.tags[0] if container.image.tags else container.short_id),
        "ports": ports,
        "link_port": link_port,
        "url_override": labels.get("dashboard.url", ""),
        "is_self": container.id.startswith(SELF_CONTAINER) and bool(SELF_CONTAINER),
        "scheme": LINK_SCHEME,
    }


ACTIONS = {"start", "stop", "restart"}


# --- Internet connectivity (real internet, not just LAN) --------------------
_net_cache = {"ts": 0.0, "online": False}


def _internet_online():
    """True if the server can reach the public internet (cached ~10s)."""
    now = time.time()
    if now - _net_cache["ts"] < 10:
        return _net_cache["online"]
    ok = False
    for host, port in (("1.1.1.1", 443), ("8.8.8.8", 53)):
        try:
            s = socket.create_connection((host, port), timeout=1.5)
            s.close()
            ok = True
            break
        except OSError:
            continue
    _net_cache.update(ts=now, online=ok)
    return ok


@app.route("/api/net")
def api_net():
    return jsonify({"online": _internet_online()})


# --- Docker event log (background listener) ---------------------------------
_events = deque(maxlen=250)
# Noisy actions we don't want to clutter the log with.
_EVENT_SKIP_PREFIXES = ("exec_",)


def _events_worker():
    """Stream container events from Docker into an in-memory ring buffer."""
    while True:
        cli = None
        try:
            cli = docker.from_env()  # dedicated long-lived client for the stream
            for ev in cli.events(decode=True):
                if ev.get("Type") != "container":
                    continue
                action = ev.get("Action", "")
                if action.startswith(_EVENT_SKIP_PREFIXES):
                    continue
                attrs = (ev.get("Actor", {}) or {}).get("Attributes", {}) or {}
                _events.appendleft({
                    "time": ev.get("time"),
                    "action": action,
                    "name": attrs.get("name", ""),
                    "image": attrs.get("image", ""),
                })
        except Exception:  # noqa: BLE001 - keep retrying on any failure
            try:
                if cli is not None:
                    cli.close()
            except Exception:  # noqa: BLE001
                pass
            time.sleep(3)


def _start_events_worker():
    t = threading.Thread(target=_events_worker, name="docker-events", daemon=True)
    t.start()


@app.route("/api/events")
def api_events():
    return jsonify({"events": list(_events)})


def _cpu_temp():
    """Best-effort CPU temperature in °C from sysfs, or None if unavailable."""
    import glob

    # Prefer a labelled package/core sensor among the thermal zones.
    best = None
    for zone in glob.glob("/sys/class/thermal/thermal_zone*"):
        try:
            with open(zone + "/type") as fh:
                typ = fh.read().strip().lower()
            with open(zone + "/temp") as fh:
                val = int(fh.read().strip())
        except (OSError, ValueError):
            continue
        celsius = val / 1000.0
        if not 0 < celsius < 150:
            continue
        if any(k in typ for k in ("x86_pkg", "coretemp", "cpu", "k10temp", "core")):
            return round(celsius, 1)
        best = celsius if best is None else max(best, celsius)

    if best is None:
        for inp in glob.glob("/sys/class/hwmon/hwmon*/temp*_input"):
            try:
                with open(inp) as fh:
                    celsius = int(fh.read().strip()) / 1000.0
            except (OSError, ValueError):
                continue
            if 0 < celsius < 150:
                best = celsius if best is None else max(best, celsius)

    return round(best, 1) if best is not None else None


def _read_meminfo():
    info = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                info[key] = int(rest.strip().split()[0])  # kB
    except OSError:
        return None
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    return {"total": total, "avail": avail, "used": max(0, total - avail)}


@app.route("/api/stats")
def api_stats():
    """Host/system stats for the System Monitor window."""
    stats = {"online": _internet_online(), "cpu_count": os.cpu_count()}

    try:
        stats["load"] = list(os.getloadavg())
    except (OSError, AttributeError):
        stats["load"] = None

    stats["mem"] = _read_meminfo()
    stats["cpu_temp"] = _cpu_temp()

    try:
        with open("/proc/uptime") as fh:
            stats["host_uptime"] = int(float(fh.read().split()[0]))
    except (OSError, ValueError):
        stats["host_uptime"] = None

    try:
        client = _client()
        conts = client.containers.list(all=True)
        stats["containers"] = {
            "total": len(conts),
            "running": sum(1 for c in conts if c.status == "running"),
        }
        stats["docker"] = client.version().get("Version")
    except Exception:  # noqa: BLE001
        _reset_client()
        stats["containers"] = None

    return jsonify(stats)


@app.route("/api/containers/<container_id>/<action>", methods=["POST"])
def api_action(container_id, action):
    if action not in ACTIONS:
        return jsonify({"error": f"unknown action '{action}'"}), 400
    try:
        client = _client()
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        return jsonify({"error": "container not found"}), 404
    except Exception as exc:  # noqa: BLE001
        _reset_client()
        return jsonify({"error": str(exc)}), 500

    # Refuse to stop/restart the dashboard's own container, otherwise the
    # request would kill the very process handling it.
    if SELF_CONTAINER and container.id.startswith(SELF_CONTAINER) and action in {"stop", "restart"}:
        return jsonify({"error": "нельзя управлять самим дашбордом"}), 400

    try:
        getattr(container, action)()
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 500

    return jsonify({"ok": True, "action": action})


@app.route("/api/containers")
def api_containers():
    try:
        client = _client()
        containers = client.containers.list(all=True)
    except Exception as exc:  # noqa: BLE001 - surface any docker error to the UI
        _reset_client()
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


# Start the Docker event listener as soon as the app is imported (works under
# both `python app.py` and a WSGI server).
_start_events_worker()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8910"))
    app.run(host="0.0.0.0", port=port)
