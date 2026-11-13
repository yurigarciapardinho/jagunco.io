#!/usr/bin/env python3
"""Destructive proof restricted to a disposable GitHub-hosted VM."""
import json, os, pathlib, subprocess
assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
packages = ["docker-ce", "docker-ce-cli", "docker-buildx-plugin", "docker-compose-plugin", "containerd.io", "docker.io", "containerd", "runc", "moby-engine", "moby-cli", "moby-buildx", "moby-compose", "moby-containerd", "moby-runc"]
installed = []
for name in packages:
    check = subprocess.run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}", name], capture_output=True, text=True)
    if check.returncode == 0 and check.stdout.startswith("ii"):
        installed.append(name)
subprocess.run(["sudo", "systemctl", "stop", "docker.socket", "docker"], check=False)
if installed:
    subprocess.run(["sudo", "apt-get", "purge", "-y", *installed], check=True)
assert subprocess.run(["sh", "-c", "command -v docker"], capture_output=True).returncode != 0
for name in ["docker.list", "docker.sources"]:
    subprocess.run(["sudo", "rm", "-f", "/etc/apt/sources.list.d/" + name], check=True)
subprocess.run(["sudo", "bash", "scripts/bootstrap-host.sh"], check=True)
info = json.loads(subprocess.check_output(["docker", "info", "--format", "{{json .}}"], text=True))
assert info["ServerVersion"].startswith("29.")
report = {"softwareInitiallyAbsent": True, "bootstrapSourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "engine": info["ServerVersion"], "compose": subprocess.check_output(["docker", "compose", "version", "--short"], text=True).strip(), "driver": info["Driver"], "cgroup": info["CgroupVersion"]}
pathlib.Path(os.environ["RUNNER_TEMP"], "host-bootstrap-result.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
