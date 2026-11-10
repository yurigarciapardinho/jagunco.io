#!/usr/bin/env python3
"""Host operator, never imported by the web application."""

import argparse, datetime, fcntl, hashlib, json, os, pathlib, re, secrets, shutil, subprocess, sys, tarfile, tempfile, time

ROOT = pathlib.Path(__file__).resolve().parents[2]


def run(args, *, capture=False, data=None, check=True):
    p = subprocess.run(
        [str(a) for a in args],
        input=data,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if check and p.returncode:
        raise RuntimeError(
            "Operation failed: "
            + str(args[0])
            + " (details retained in local service logs)"
        )
    return p.stdout if capture else p.returncode


def inspect(container):
    return json.loads(run(["docker", "inspect", container], capture=True))[0]


def container(project, service):
    ids = run(
        [
            "docker",
            "ps",
            "-aq",
            "--filter",
            "label=com.docker.compose.project=" + project,
            "--filter",
            "label=com.docker.compose.service=" + service,
        ],
        capture=True,
    ).split()
    if len(ids) != 1:
        raise RuntimeError("Expected one " + service + " container")
    return ids[0]


def env_of(info):
    return dict(v.split("=", 1) for v in info["Config"].get("Env", []) if "=" in v)


def get_secret(info, key):
    env = env_of(info)
    if key + "_FILE" in env:
        return run(
            ["docker", "exec", info["Id"], "cat", env[key + "_FILE"]], capture=True
        ).strip()
    if env.get(key):
        return env[key]
    raise RuntimeError("Missing existing " + key)


def write(path, value, uid=1000, gid=1000):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise RuntimeError("Refusing symlink")
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        with os.fdopen(fd, "w") as f:
            f.write(value + "\n")
        if os.geteuid() == 0:
            os.chown(path, uid, gid)
        elif uid != os.getuid():
            os.chmod(path, 0o440)
            run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--read-only",
                    "--cap-drop",
                    "ALL",
                    "--cap-add",
                    "CHOWN",
                    "--cap-add",
                    "DAC_OVERRIDE",
                    "--user",
                    "0:0",
                    "-v",
                    str(path.parent) + ":/secrets",
                    "--entrypoint",
                    "chown",
                    "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68",
                    str(uid) + ":" + str(os.getgid()),
                    "/secrets/" + path.name,
                ]
            )
    return path.read_text().strip()


def settings(directory):
    return dict(
        line.split("=", 1)
        for line in (directory / ".ops/compose.env").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )


def compose(directory, *args):
    env = settings(directory)
    cmd = [
        "docker",
        "compose",
        "--project-directory",
        directory,
        "--env-file",
        directory / ".ops/compose.env",
        "-p",
        env["PROJECT"],
        "-f",
        directory / "compose.yaml",
        "-f",
        directory / "compose.production.yaml",
    ]
    if env.get("ENVIRONMENT") == "development":
        cmd += ["-f", directory / "compose.development.yaml"]
    if env.get("CONTROL_ENABLED") == "1":
        cmd += ["-f", directory / "compose.control.yaml"]
    return run(cmd + list(args))


def save_settings(directory, values):
    for k, v in values.items():
        if not re.fullmatch("[A-Z_]+", k) or "\n" in str(v) or "\r" in str(v):
            raise RuntimeError("Invalid setting")
    file = directory / ".ops/compose.env"
    file.parent.mkdir(exist_ok=True, mode=0o700)
    file.write_text("".join(k + "=" + str(v) + "\n" for k, v in values.items()))
    file.chmod(0o600)


def root_sql(project, sql):
    db = container(project, "db")
    # Credential is read inside mysqld's container, never put in argv/stdout.
    shell = """set -eu
umask 077
f=$(mktemp)
trap 'rm -f "$f"' EXIT
if [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ]; then p=$(cat "$MYSQL_ROOT_PASSWORD_FILE"); else p=$MYSQL_ROOT_PASSWORD; fi
printf '[client]\\nuser=root\\npassword=%s\\n' "$p" > "$f"
unset p
mysql --defaults-extra-file="$f" --batch --skip-column-names"""
    # mysql receives only the SQL payload on stdin.
    return run(["docker", "exec", "-i", db, "sh", "-c", shell], capture=True, data=sql)


def provision(directory, control_dir=None):
    env = settings(directory)
    project = env["PROJECT"]
    sec = directory / ".secrets"
    control = control_dir is not None
    schema = "jagunco_control" if control else "jagunco"
    user = "jagunco_control" if control else "jagunco_runtime"
    migrator = user + "_migrate"
    destination = pathlib.Path(control_dir) if control else directory
    password = write(destination / ".secrets/database_password", secrets.token_hex(32))
    migration = write(
        destination / ".secrets/migration_password", secrets.token_hex(32)
    )
    root_sql(
        project,
        f"CREATE DATABASE IF NOT EXISTS `{schema}` CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS '{user}'@'%' IDENTIFIED BY '{password}'; ALTER USER '{user}'@'%' IDENTIFIED BY '{password}'; CREATE USER IF NOT EXISTS '{migrator}'@'%' IDENTIFIED BY '{migration}'; ALTER USER '{migrator}'@'%' IDENTIFIED BY '{migration}'; GRANT SELECT,INSERT,UPDATE,DELETE ON `{schema}`.* TO '{user}'@'%'; GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES ON `{schema}`.* TO '{migrator}'@'%';",
    )
    prefix = "control" if control else "game"
    host = env.get("DB_HOST", "db")
    write(
        destination / f".secrets/{prefix}_database_url",
        f"mysql://{user}:{password}@{host}:3306/{schema}",
    )
    write(
        destination / f".secrets/{prefix}_migration_url",
        f"mysql://{migrator}:{migration}@{host}:3306/{schema}",
    )
    if control:
        write(
            destination / ".secrets/game_control_secret",
            (sec / "control_secret").read_text().strip(),
        )


def ready(project, service, timeout=120):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            item = inspect(container(project, service))
            status = item["State"].get("Health", {}).get("Status")
            if item["State"]["Running"] and status == "healthy":
                return
            if not item["State"]["Running"]:
                raise RuntimeError("Service stopped")
        except RuntimeError:
            pass
        time.sleep(2)
    raise RuntimeError("Readiness deadline exceeded: " + service)


def install(a, directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    if (directory / ".ops/compose.env").exists():
        old = settings(directory)
        if old["PROJECT"] != a.project:
            raise RuntimeError("Project mismatch")
        if a.image and a.image != old["GAME_IMAGE"]:
            raise RuntimeError("Use ops.sh deploy to change an installed image")
        if ROOT.resolve() != directory.resolve():
            for name in [
                "compose.yaml",
                "compose.production.yaml",
                "compose.development.yaml",
                "compose.control.yaml",
            ]:
                shutil.copy2(ROOT / name, directory / name)
            for script in ["install.sh", "ops.sh", "lib/operate.py"]:
                shutil.copy2(ROOT / "scripts" / script, directory / "scripts" / script)
        compose(directory, "config", "--quiet")
        provision(directory)
        compose(directory, "run", "--rm", "--no-deps", "init-data")
        compose(directory, "run", "--rm", "--no-deps", "migrate")
        compose(directory, "up", "-d", "--no-deps", "app")
        ready(old["PROJECT"], "app")
        (directory / ".ops/install-state.json").write_text(
            json.dumps({"status": "ready", "at": time.time()}) + "\n"
        )
        print("Existing installation ready; identities, secrets and volumes preserved")
        return
    if not a.image:
        raise RuntimeError("--image required")
    image = inspect_image(a.image)
    values = {
        "PROJECT": a.project,
        "ENVIRONMENT": "development" if a.development else "production",
        "GAME_IMAGE": a.image,
        "MYSQL_IMAGE": "mysql:8.4.13@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902",
        "CADDY_IMAGE": "caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee",
        "OWNER_EMAIL": a.owner_email or "",
        "CONTROL_ENABLED": "1" if a.control else "0",
        "FRONT_NETWORK": a.project + "_front",
        "DATA_NETWORK": a.project + "_data",
        "CONTROL_VOLUME": a.project + "_control-socket",
        "DEV_PORT": str(a.port),
    }
    mount_keys = {
        "MYSQL_VOLUME": ("/var/lib/mysql", "db"),
        "GAME_VOLUME": ("/app/server/data", "app"),
        "CADDY_DATA_VOLUME": ("/data/caddy", "caddy"),
        "CADDY_CONFIG_VOLUME": ("/config/caddy", "caddy"),
    }
    app_info = db_info = None
    if a.adopt:
        app_info = inspect(container(a.project, "app"))
        db_info = inspect(container(a.project, "db"))
        for key, (target, svc) in mount_keys.items():
            mounts = inspect(container(a.project, svc))["Mounts"]
            volume_match = next(
                (
                    m
                    for m in mounts
                    if m["Destination"] == target and m["Type"] == "volume"
                ),
                None,
            )
            if not volume_match:
                raise RuntimeError("Cannot adopt volume " + target)
            values[key] = volume_match["Name"]
        values["OWNER_EMAIL"] = a.owner_email or env_of(app_info).get("OWNER_EMAIL", "")
    else:
        for key, (target, svc) in mount_keys.items():
            values[key] = (
                a.project
                + "_"
                + {
                    "MYSQL_VOLUME": "mysql-data",
                    "GAME_VOLUME": "game-data",
                    "CADDY_DATA_VOLUME": "caddy-data",
                    "CADDY_CONFIG_VOLUME": "caddy-config",
                }[key]
            )
    for key in [
        "MYSQL_VOLUME",
        "GAME_VOLUME",
        "CADDY_DATA_VOLUME",
        "CADDY_CONFIG_VOLUME",
        "CONTROL_VOLUME",
    ]:
        run(
            [
                "docker",
                "volume",
                "create",
                "--label",
                "io.jagunco.project=" + a.project,
                values[key],
            ],
            capture=True,
        )
    for key in ["FRONT_NETWORK", "DATA_NETWORK"]:
        if (
            run(
                ["docker", "network", "inspect", values[key]], capture=True, check=False
            )
            == ""
            or subprocess.run(
                ["docker", "network", "inspect", values[key]],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
        ):
            run(
                [
                    "docker",
                    "network",
                    "create",
                    "--label",
                    "io.jagunco.project=" + a.project,
                    values[key],
                ],
                capture=True,
            )
    if a.adopt:
        for svc, network in [
            ("db", values["DATA_NETWORK"]),
            ("caddy", values["FRONT_NETWORK"]),
        ]:
            info = inspect(container(a.project, svc))
            if network not in info["NetworkSettings"]["Networks"]:
                run(
                    [
                        "docker",
                        "network",
                        "connect",
                        "--alias",
                        svc,
                        network,
                        info["Id"],
                    ]
                )
    sec = directory / ".secrets"
    sec.mkdir(exist_ok=True, mode=0o700)
    write(
        sec / "db_root_password",
        get_secret(db_info, "MYSQL_ROOT_PASSWORD")
        if db_info
        else secrets.token_hex(32),
        999,
        999,
    )
    write(
        sec / "db_boot_password",
        get_secret(db_info, "MYSQL_PASSWORD") if db_info else secrets.token_hex(32),
        999,
        999,
    )
    write(
        sec / "app_secret",
        get_secret(app_info, "APP_SECRET") if app_info else secrets.token_hex(32),
    )
    write(sec / "control_secret", secrets.token_hex(32))
    domain = a.domain
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", domain):
        raise RuntimeError("Invalid domain")
    if ROOT.resolve() != directory.resolve():
        (directory / "scripts/lib").mkdir(parents=True, exist_ok=True)
        for script in ["install.sh", "ops.sh", "lib/operate.py"]:
            shutil.copy2(ROOT / "scripts" / script, directory / "scripts" / script)
    if a.adopt:
        for name in ["compose.yaml", "Caddyfile", ".env"]:
            old = directory / name
            if old.exists():
                shutil.copy2(
                    old, directory / ".ops" / ("legacy-" + name.replace(".", "_"))
                )
    for name in [
        "compose.yaml",
        "compose.production.yaml",
        "compose.development.yaml",
        "compose.control.yaml",
    ]:
        source = ROOT / name
        target = directory / name
        if source.resolve() != target.resolve():
            shutil.copy2(source, target)
    # Preserve existing certificate volumes. Configuration uses the same public hostname.
    if not (directory / "Caddyfile").exists():
        (directory / "Caddyfile").write_text(
            domain + " {\n    encode zstd gzip\n    reverse_proxy app:3000\n}\n"
        )
    save_settings(directory, values)
    compose(directory, "config", "--quiet")
    if not a.adopt:
        compose(directory, "up", "-d", "db")
        ready(a.project, "db")
    provision(directory)
    compose(directory, "run", "--rm", "--no-deps", "init-data")
    compose(directory, "run", "--rm", "--no-deps", "migrate")
    previous = app_info["Image"] if app_info else None
    release = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "image": a.image,
        "imageId": image["Id"],
        "previousImage": previous,
        "volumes": {k: v for k, v in values.items() if k.endswith("_VOLUME")},
    }
    (directory / ".ops/release.json").write_text(json.dumps(release, indent=2) + "\n")
    compose(directory, "up", "-d", "--no-deps", "app")
    ready(a.project, "app")
    if not a.development:
        compose(directory, "up", "-d", "--no-deps", "caddy")
    (directory / ".ops/install-state.json").write_text(
        json.dumps({"status": "ready", "at": time.time()}) + "\n"
    )
    print("Game installation ready; secrets remain in protected files")


def inspect_image(image):
    return json.loads(run(["docker", "image", "inspect", image], capture=True))[0]


def backup(directory, a):
    env = settings(directory)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = directory / "backups" / stamp
    out.mkdir(parents=True, mode=0o700)
    os.chmod(out.parent, 0o700)
    if a.control_dir:
        # Pause authorship to bind SQL and immutable map versions to one point.
        run(
            [
                pathlib.Path(a.control_dir) / "scripts/ops.sh",
                "stop",
                "--directory",
                a.control_dir,
            ]
        )
    try:
        shell = """set -eu; umask 077; f=$(mktemp); trap 'rm -f "$f"' EXIT; if [ -n "${MYSQL_ROOT_PASSWORD_FILE:-}" ]; then p=$(cat "$MYSQL_ROOT_PASSWORD_FILE"); else p=$MYSQL_ROOT_PASSWORD; fi; printf '[client]\\nuser=root\\npassword=%s\\n' "$p" > "$f"; unset p; mysqldump --defaults-extra-file="$f" --single-transaction --quick --skip-lock-tables --no-tablespaces --set-gtid-purged=OFF --databases jagunco"""
        if a.control_dir:
            shell += " jagunco_control"
        db = container(env["PROJECT"], "db")
        with open(out / "database.sql", "wb") as f:
            subprocess.run(
                ["docker", "exec", db, "sh", "-c", shell], stdout=f, check=True
            )
        os.chmod(out / "database.sql", 0o600)
        for key, name in [
            ("GAME_VOLUME", "game-data"),
            ("CADDY_DATA_VOLUME", "caddy-data"),
            ("CADDY_CONFIG_VOLUME", "caddy-config"),
        ]:
            with open(out / (name + ".tar.gz"), "wb") as target:
                subprocess.run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--network",
                        "none",
                        "--read-only",
                        "--cap-drop",
                        "ALL",
                        "--user",
                        "1000:1000" if key == "GAME_VOLUME" else "0:0",
                        "-v",
                        env[key] + ":/data:ro",
                        "--entrypoint",
                        "tar",
                        env["GAME_IMAGE"],
                        "czf",
                        "-",
                        "-C",
                        "/data",
                        ".",
                    ],
                    stdout=target,
                    check=True,
                )
            os.chmod(out / (name + ".tar.gz"), 0o600)
        with tarfile.open(out / "recovery.tar.gz", "w:gz") as tar:
            for name in [
                ".secrets",
                ".ops",
                "Caddyfile",
                "compose.yaml",
                "compose.production.yaml",
                "compose.control.yaml",
            ]:
                tar.add(directory / name, arcname="game/" + name)
            if a.control_dir:
                for name in [
                    ".secrets",
                    ".ops",
                    "compose.yaml",
                    "compose.production.yaml",
                    "compose.preview.yaml",
                ]:
                    path = pathlib.Path(a.control_dir) / name
                    if path.exists():
                        tar.add(path, arcname="control/" + name)
        os.chmod(out / "recovery.tar.gz", 0o600)
        manifest = {
            "at": stamp,
            "gameImage": env["GAME_IMAGE"],
            "containsSecrets": True,
            "sha256": {
                p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in out.iterdir()
                if p.is_file()
            },
        }
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        os.chmod(out / "manifest.json", 0o600)
    finally:
        if a.control_dir:
            run(
                [
                    pathlib.Path(a.control_dir) / "scripts/ops.sh",
                    "start",
                    "--directory",
                    a.control_dir,
                ]
            )
    print("Protected backup created: " + str(out))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=[
            "install",
            "start",
            "stop",
            "status",
            "migrate",
            "deploy",
            "rollback",
            "backup",
            "restore",
            "provision-control",
        ],
    )
    parser.add_argument("--directory", default="/opt/jagunco")
    parser.add_argument("--project", default="jagunco")
    parser.add_argument("--image")
    parser.add_argument("--adopt", action="store_true")
    parser.add_argument("--control", action="store_true")
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--domain", default="54.221.34.83.sslip.io")
    parser.add_argument("--owner-email")
    parser.add_argument("--control-dir")
    parser.add_argument("--file")
    parser.add_argument("--port", type=int, default=3300)
    a = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,60}", a.project):
        raise RuntimeError("Invalid project")
    directory = pathlib.Path(a.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    (directory / ".ops").mkdir(exist_ok=True, mode=0o700)
    with open(directory / ".ops/operator.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if a.action == "install":
            return install(a, directory)
        env = settings(directory)
        if a.action == "status":
            return compose(directory, "ps")
        if a.action == "start":
            return compose(directory, "up", "-d", "app")
        if a.action == "stop":
            return compose(directory, "stop", "app")
        if a.action == "provision-control":
            if not a.control_dir or env.get("CONTROL_ENABLED") != "1":
                raise RuntimeError("Control must be enabled and its directory supplied")
            return provision(directory, a.control_dir)
        if a.action == "migrate":
            return compose(directory, "run", "--rm", "--no-deps", "migrate")
        if a.action in ["deploy", "rollback"]:
            release = json.loads((directory / ".ops/release.json").read_text())
            image = a.image if a.action == "deploy" else release.get("previousImage")
            if not image:
                raise RuntimeError("No image selected")
            info = inspect_image(image)
            old = env["GAME_IMAGE"]
            env["GAME_IMAGE"] = image
            save_settings(directory, env)
            try:
                compose(directory, "run", "--rm", "--no-deps", "migrate")
                compose(directory, "up", "-d", "--no-deps", "app")
                ready(env["PROJECT"], "app")
            except Exception:
                env["GAME_IMAGE"] = old
                save_settings(directory, env)
                compose(directory, "up", "-d", "--no-deps", "app")
                raise
            (directory / ".ops/release.json").write_text(
                json.dumps(
                    {
                        "image": image,
                        "imageId": info["Id"],
                        "previousImage": old,
                        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    },
                    indent=2,
                )
                + "\n"
            )
            print("Selected image is ready")
            return
        if a.action == "backup":
            return backup(directory, a)
        if a.action == "restore":
            if not a.file:
                raise RuntimeError("--file database.sql required")
            source = pathlib.Path(a.file).resolve()
            manifest = json.loads((source.parent / "manifest.json").read_text())
            if hashlib.sha256(source.read_bytes()).hexdigest() != manifest[
                "sha256"
            ].get(source.name):
                raise RuntimeError("Backup integrity mismatch")
            if a.control_dir:
                run(
                    [
                        pathlib.Path(a.control_dir) / "scripts/ops.sh",
                        "stop",
                        "--directory",
                        a.control_dir,
                    ]
                )
            compose(directory, "stop", "app")
            # Snapshot hydration must happen only after restore, never over running RAM.
            root_sql(env["PROJECT"], source.read_text())
            compose(directory, "run", "--rm", "--no-deps", "migrate")
            compose(directory, "up", "-d", "app")
            ready(env["PROJECT"], "app")
            if a.control_dir:
                run(
                    [
                        pathlib.Path(a.control_dir) / "scripts/ops.sh",
                        "start",
                        "--directory",
                        a.control_dir,
                    ]
                )
            print("Restore completed and hydrated")
            return


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Operator: " + str(e), file=sys.stderr)
        sys.exit(1)
