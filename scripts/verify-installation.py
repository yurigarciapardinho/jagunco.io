#!/usr/bin/env python3
"""Standalone installation and recovery; only creates disposable Docker projects."""
import argparse, hashlib, importlib.util, json, pathlib, secrets, shutil, subprocess, time, urllib.error, urllib.request

SOURCE = pathlib.Path(__file__).resolve().parents[1]


def request(base, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            value = response.read()
            return response.status, json.loads(value) if value else None
    except urllib.error.HTTPError as error:
        return error.code, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=33410)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path(args.directory).resolve()
    if root.exists() and any(root.iterdir()):
        raise RuntimeError("Choose a new empty lab directory")
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    logs = root / "logs"
    logs.mkdir()
    directory = root / "game"
    project = "jagunco-it-" + secrets.token_hex(4)
    base = "http://127.0.0.1:" + str(args.port)
    marker = {"purpose": "public-installation", "project": project}
    (root / "fixture.json").write_text(json.dumps(marker) + "\n")
    results = []

    def run(values):
        with open(logs / "operations.log", "a") as output:
            result = subprocess.run([str(x) for x in values], stdout=output, stderr=output)
        if result.returncode:
            raise RuntimeError("Lab operation failed; inspect protected local log")

    def check(name, callback):
        callback()
        results.append({"name": name, "pass": True})
        print("PASS " + name, flush=True)

    def install():
        run([SOURCE / "scripts/install.sh", "--directory", directory, "--project", project,
             "--image", args.image, "--development", "--port", args.port])

    def operator(action, *options):
        run([directory / "scripts/ops.sh", action, "--directory", directory, *options])

    def ready():
        for _ in range(120):
            try:
                if request(base, "/ready")[0] == 200:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        raise RuntimeError("Lab readiness deadline exceeded")

    def fingerprint():
        return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in (directory / ".secrets").iterdir() if path.is_file()}

    try:
        missing_domain = root / "missing-domain"
        negative = subprocess.run([str(SOURCE / "scripts/install.sh"), "--directory", str(missing_domain),
            "--project", project + "-domain", "--image", args.image], text=True, capture_output=True)
        assert negative.returncode != 0 and "Supply --domain" in negative.stderr
        assert not (missing_domain / ".secrets").exists()
        results.append({"name": "production requires an operator hostname before creating secrets", "pass": True})
        check("public image installs without private control", install)
        spec = importlib.util.spec_from_file_location("standalone_operator", directory / "scripts/lib/operate.py")
        op = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(op)
        values = op.settings(directory)
        app = op.container(project, "app")
        info = op.inspect(app)
        assert values["CONTROL_ENABLED"] == "0"
        assert info["Config"]["User"] == "node" and info["HostConfig"]["ReadonlyRootfs"]
        assert not any(m["Destination"] == "/run/jagunco-control" for m in info["Mounts"])
        assert values["GAME_IMAGE"] == info["Image"]
        assert values["GAME_IMAGE"].startswith("sha256:")
        assert request(base, "/ready")[0] == 200
        results.append({"name": "nonroot readonly runtime and immutable image selection", "pass": True})
        before = fingerprint()
        check("repeated install preserves secrets and volume identities", install)
        assert fingerprint() == before
        assert op.settings(directory)["GAME_VOLUME"] == values["GAME_VOLUME"]
        password = "Synthetic " + secrets.token_hex(24)
        email = "replication-" + secrets.token_hex(8) + "@example.invalid"

        def auth(register=False):
            status, data = request(base, "/api/auth/password", {"email": email, "password": password, "register": register})
            assert status == 200
            return data

        account_id = auth(True)["id"]
        operator("stop")
        operator("start")
        ready()
        assert auth()["id"] == account_id
        results.append({"name": "MySQL account survives runtime restart", "pass": True})
        check("standalone backup completes", lambda: operator("backup"))
        backups = sorted((directory / "backups").iterdir())
        assert backups and (backups[-1] / "database.sql").is_file()
        after_email = "after-backup-" + secrets.token_hex(8) + "@example.invalid"
        assert request(base, "/api/auth/password", {"email": after_email, "password": password, "register": True})[0] == 200
        check("standalone restore starts the saved database", lambda: operator("restore", "--file", backups[-1] / "database.sql"))
        ready()
        assert auth()["id"] == account_id
        assert request(base, "/api/auth/password", {"email": after_email, "password": password})[0] == 400
        assert fingerprint() == before
        results.append({"name": "restore reverts later account and preserves original identity", "pass": True})
        assert request(base, "/health")[0] == 200
        summary = {"pass": True, "results": results}
        (root / "installation-result.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps({"pass": True, "tests": len(results)}))
    finally:
        if not args.keep:
            assert project.startswith("jagunco-it-")
            ids = subprocess.check_output(["docker", "ps", "-aq", "--filter",
                                           "label=com.docker.compose.project=" + project], text=True).split()
            if ids:
                subprocess.run(["docker", "rm", "-f", *ids], check=True, stdout=subprocess.DEVNULL)
            for network in [project + "_front", project + "_data"]:
                subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for suffix in ["mysql-data", "game-data", "caddy-data", "caddy-config", "control-socket"]:
                subprocess.run(["docker", "volume", "rm", project + "_" + suffix], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(directory / ".secrets", ignore_errors=True)
            shutil.rmtree(directory / "backups", ignore_errors=True)


if __name__ == "__main__":
    main()

