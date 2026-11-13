#!/usr/bin/env python3
"""Publish a reviewed candidate to GHCR from the repository that owns it."""
import argparse
import contextlib
import json
import os
import pathlib
import re
import subprocess
import urllib.request
import urllib.error


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def output(args):
    return subprocess.check_output([str(x) for x in args], text=True).strip()


@contextlib.contextmanager
def registry_login(token, owner):
    # Preserve the selected buildx builder and any pre-existing Docker identity.
    directory = pathlib.Path(os.environ.get("DOCKER_CONFIG", pathlib.Path.home() / ".docker"))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = directory / "config.json"
    previous = config.read_bytes() if config.exists() else None
    mode = config.stat().st_mode & 0o777 if config.exists() else 0o600
    if previous and any(k in json.loads(previous) for k in ("credsStore", "credHelpers")):
        raise RuntimeError("Use a dedicated Docker config without external credential helpers")
    try:
        run(["docker", "login", "ghcr.io", "--username", owner, "--password-stdin"],
            input=token + "\n", text=True)
        config.chmod(0o600)
        yield
    finally:
        if previous is None:
            config.unlink(missing_ok=True)
        else:
            config.write_bytes(previous)
            config.chmod(mode)


def verify_manifest(path, token, signed):
    manifest = json.loads(pathlib.Path(path).read_text())
    repository = os.environ["GITHUB_REPOSITORY"]
    if manifest["repository"] != repository or manifest["revision"] != os.environ["GITHUB_SHA"]:
        raise RuntimeError("Manifest does not describe this reviewed source")
    reference = manifest["image"]
    if not re.fullmatch(r"ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}", reference):
        raise RuntimeError("Verification requires an immutable registry reference")
    with registry_login(token, repository.split("/")[0]):
        run(["docker", "pull", reference])
        image = json.loads(output(["docker", "image", "inspect", reference]))[0]
        labels = image["Config"]["Labels"]
        if labels["org.opencontainers.image.revision"] != manifest["revision"]:
            raise RuntimeError("Registry image source label differs from the manifest")
        runtime = output(["docker", "run", "--rm", "--entrypoint", "node", reference, "--version"])
        if runtime != "v26.13.1":
            raise RuntimeError("Registry image uses an unreviewed Node runtime")
        evidence = {"image": reference, "revision": manifest["revision"], "node": runtime,
                    "pulled": True, "signedProvenanceVerified": False}
        if signed:
            attestation = output(["gh", "attestation", "verify", "oci://" + reference,
                                  "--repo", repository, "--signer-workflow",
                                  repository + "/.github/workflows/release.yml", "--format", "json"])
            evidence["signedProvenanceVerified"] = True
            evidence["attestation"] = json.loads(attestation)
        target = pathlib.Path(path).with_name(manifest["component"] + "-verification.json")
        target.write_text(json.dumps(evidence, indent=2) + "\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def github(repository, path, token):
    request = urllib.request.Request(
        "https://api.github.com/repos/" + repository + path,
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github+json", "User-Agent": "jagunco-release"},
    )
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        return json.load(response)


def require_gate(repository, revision, token):
    checks = github(repository, "/commits/" + revision + "/check-runs?per_page=100", token)
    if not any(c["name"] == "gate" and c["conclusion"] == "success"
               and c["app"]["slug"] == "github-actions" for c in checks["check_runs"]):
        raise RuntimeError("The exact source revision needs a successful CI gate")


def package_visibility(owner, component, token):
    request = urllib.request.Request(
        "https://api.github.com/users/" + owner + "/packages/container/jagunco-" + component,
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github+json", "User-Agent": "jagunco-release"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            return json.load(response)["visibility"]
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=["game", "control", "preview"])
    parser.add_argument("--candidate", type=int, default=1)
    parser.add_argument("--verify-manifest")
    parser.add_argument("--signed", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path.cwd()
    repository = os.environ["GITHUB_REPOSITORY"]
    token = os.environ.get("GH_TOKEN") or os.environ["GITHUB_TOKEN"]
    if args.verify_manifest:
        verify_manifest(args.verify_manifest, token, args.signed)
        return
    if not args.component:
        parser.error("--component is required when publishing")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise RuntimeError("Invalid source repository")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Publication is only allowed from main")
    remote = output(["git", "remote", "get-url", "origin"])
    if remote not in {"https://github.com/" + repository,
                      "https://github.com/" + repository + ".git",
                      "git@github.com:" + repository + ".git"}:
        raise RuntimeError("Source checkout does not belong to the publishing repository")
    package = json.loads((root / "package.json").read_text())
    allowed = {"jagunco-io": {"game"}, "jagunco-control": {"control", "preview"}}
    if args.component not in allowed.get(package["name"], set()):
        raise RuntimeError("This component cannot be published from this source tree")
    version = package["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not 1 <= args.candidate <= 999:
        raise RuntimeError("Use a package version and candidate number")
    if output(["git", "status", "--porcelain"]):
        raise RuntimeError("Publication requires a clean source checkout")
    revision = output(["git", "rev-parse", "HEAD"])
    if revision != os.environ["GITHUB_SHA"]:
        raise RuntimeError("Source revision differs from the workflow revision")
    require_gate(repository, revision, token)
    source = github(repository, "", token)
    if source["private"] != (args.component != "game"):
        raise RuntimeError("Game source must be public; control and preview source must remain private")
    owner = repository.split("/")[0].lower()
    image = "ghcr.io/" + owner + "/jagunco-" + args.component
    visibility = package_visibility(owner, args.component, token)
    if args.component != "game" and visibility not in (None, "private"):
        raise RuntimeError("Refusing to publish private code into a non-private package")
    tag = "v" + version + "-rc." + str(args.candidate)
    destination = pathlib.Path(os.environ["RUNNER_TEMP"]) / "jagunco-release"
    destination.mkdir(mode=0o700, exist_ok=True)
    metadata = destination / (args.component + "-build.json")
    build = ["docker", "buildx", "build", "--platform", "linux/amd64", "--push",
             "--provenance=mode=min", "--sbom=true", "--metadata-file", metadata,
             "--tag", image + ":" + tag, "--tag", image + ":sha-" + revision,
             "--label", "org.opencontainers.image.source=https://github.com/" + repository,
             "--label", "org.opencontainers.image.revision=" + revision,
             "--label", "org.opencontainers.image.version=" + version,
             "--build-arg", "VCS_REF=" + revision, "--build-arg", "VERSION=" + version]
    if args.component == "preview":
        contract = json.loads((root / "contracts/game.json").read_text())
        game_image = contract["image"]
        if not re.fullmatch(r"ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}", game_image):
            raise RuntimeError("Preview requires a game pinned by registry digest")
        build += ["-f", "Dockerfile.preview", "--build-arg", "GAME_IMAGE=" + game_image]
    build += [root]
    # The login is local to this job and never enters the build context or argv.
    with registry_login(token, owner):
        existing = subprocess.run(["docker", "buildx", "imagetools", "inspect", image + ":" + tag],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if existing.returncode == 0:
            raise RuntimeError("Candidate already exists; use the next candidate number")
        run(build)
        digest = json.loads(metadata.read_text())["containerimage.digest"]
        reference = image + "@" + digest
        for name, field in [("sbom", "SBOM"), ("provenance", "Provenance")]:
            value = output(["docker", "buildx", "imagetools", "inspect", reference,
                            "--format", "{{json ." + field + "}}"])
            if not json.loads(value):
                raise RuntimeError("The image is missing " + name)
            (destination / (args.component + "-" + name + ".json")).write_text(value + "\n")
    visibility = package_visibility(owner, args.component, token)
    if args.component != "game" and visibility != "private":
        raise RuntimeError("Private package visibility could not be verified")
    manifest = {
        "schemaVersion": 1, "component": args.component, "version": version, "candidate": tag,
        "repository": repository, "revision": revision,
        "tree": output(["git", "rev-parse", "HEAD^{tree}"]),
        "image": reference, "digest": digest, "platform": "linux/amd64",
        "intendedVisibility": "public" if args.component == "game" and not source["private"] else "private",
        "observedVisibility": visibility,
        "workflow": "https://github.com/" + repository + "/actions/runs/" + os.environ["GITHUB_RUN_ID"],
        "buildx": output(["docker", "buildx", "version"]),
    }
    if args.component != "game":
        manifest["game"] = json.loads((root / "contracts/game.json").read_text())
    (destination / (args.component + "-manifest.json")).write_text(json.dumps(manifest, indent=2) + "\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output_file:
        output_file.write("digest=" + digest + "\nimage=" + image + "\ncandidate=" + tag + "\n")
    print(json.dumps({"image": reference, "candidate": tag, "manifest": str(destination)}))


if __name__ == "__main__":
    main()
