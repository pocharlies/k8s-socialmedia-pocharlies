# Tiltfile — k8s-socialmedia-pocharlies
#
# Dev workflow: `tilt up` watches source → rebuilds images → hot-reloads pods
# Requires: tilt, kubectl pointed at the homelab cluster, kubecontext set
#
# Switch dev/prod:
#   tilt up              → dev mode (local builds, live_update sync)
#   tilt args -- --prod  → prod mode (reference only, no builds)

# ── Config ───────────────────────────────────────────────────────────────────
REGISTRY = "ghcr.io/pocharlies"
NAMESPACE = "whatsapp-mcp"

config.define_bool("prod")
cfg = config.parse()
is_prod = cfg.get("prod", False)

# ── Load k8s manifests ───────────────────────────────────────────────────────
k8s_yaml("k8s/manifest.yaml")

# ── Helper: build a Node.js monorepo service ─────────────────────────────────
def node_service(name, image_suffix, dockerfile, watch_dirs, port=None):
    """Build a Node.js service from the pnpm monorepo root context."""
    img = REGISTRY + "/socialmedia-" + image_suffix

    if not is_prod:
        docker_build(
            img,
            ".",                    # build context = repo root (pnpm workspace)
            dockerfile=dockerfile,
            only=watch_dirs + [
                "shared",
                "package.json",
                "pnpm-workspace.yaml",
                "pnpm-lock.yaml",
                "tsconfig.json",
                ".dockerignore",
            ],
            live_update=[
                # Sync source changes into the running container instantly (tsx hot-reload)
                sync("./" + d, "/app/" + d) for d in watch_dirs
            ] + [
                sync("./shared", "/app/shared"),
                # After a sync, restart the process if package.json changed
                run("cd /app && pnpm install --frozen-lockfile",
                    trigger=["./package.json", "./pnpm-lock.yaml"]),
            ],
        )

    if port:
        k8s_resource(name, port_forwards=port, resource_deps=[])

# ── Services ──────────────────────────────────────────────────────────────────
node_service(
    name="whatsapp-connector",
    image_suffix="whatsapp-connector",
    dockerfile="connectors/whatsapp-web/Dockerfile",
    watch_dirs=["connectors/whatsapp-web"],
    port="3001:3001",
)

node_service(
    name="whatsapp-cloud-connector",
    image_suffix="whatsapp-cloud-connector",
    dockerfile="connectors/whatsapp-cloud/Dockerfile",
    watch_dirs=["connectors/whatsapp-cloud"],
    port="3004:3004",
)

node_service(
    name="telegram-connector",
    image_suffix="telegram-connector",
    dockerfile="connectors/telegram/Dockerfile",
    watch_dirs=["connectors/telegram"],
    port="3002:3002",
)

node_service(
    name="instagram-connector",
    image_suffix="instagram-connector",
    dockerfile="connectors/instagram/Dockerfile",
    watch_dirs=["connectors/instagram"],
    port="3003:3003",
)

node_service(
    name="auto-reply-worker",
    image_suffix="auto-reply-worker",
    dockerfile="workers/auto-reply-worker/Dockerfile",
    watch_dirs=["workers/auto-reply-worker"],
)

# ── MCP Server ────────────────────────────────────────────────────────────────
node_service(
    name="mcp-server",
    image_suffix="mcp-server",
    dockerfile="mcp-server/Dockerfile",
    watch_dirs=["mcp-server"],
    port="3000:3000",
)

# ── Telegram Sync (Python) ───────────────────────────────────────────────────
TSYNC_IMG = REGISTRY + "/socialmedia-telegram-sync"
if not is_prod:
    docker_build(
        TSYNC_IMG,
        ".",
        dockerfile="connectors/telegram-sync/Dockerfile",
        only=[
            "connectors/telegram-sync",
        ],
        live_update=[
            sync("./connectors/telegram-sync/sync", "/app/sync"),
            sync("./connectors/telegram-sync/run_sync.py", "/app/run_sync.py"),
        ],
    )
k8s_resource("telegram-sync", resource_deps=[])

# ── Infrastructure (no builds, just show status) ──────────────────────────────
k8s_resource("whatsapp-mcp-postgres", labels=["infra"])
k8s_resource("whatsapp-mcp-redis",    labels=["infra"])
k8s_resource("whatsapp-mcp-nats",     labels=["infra"])
k8s_resource("whatsapp-mcp-minio",    labels=["infra"])

# ── Labels for Tilt UI grouping ───────────────────────────────────────────────
k8s_resource("whatsapp-connector",       labels=["connectors"])
k8s_resource("whatsapp-cloud-connector", labels=["connectors"])
k8s_resource("telegram-connector",       labels=["connectors"])
k8s_resource("telegram-sync",            labels=["connectors"])
k8s_resource("instagram-connector",      labels=["connectors"])
k8s_resource("mcp-server",               labels=["app"])
k8s_resource("auto-reply-worker",        labels=["workers"])
