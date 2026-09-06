#!/usr/bin/env bash
# Build and push the Spatial Data Studio image to the Cirro public ECR, tagged
# with the current git commit hash and with any git tags pointing at that commit.
set -euo pipefail

REGISTRY="public.ecr.aws/cirrobio"
IMAGE="spatial-data-studio"

# Every plain vX.Y.Z tag in the repo matching glob $1, oldest release first.
releases() {
  git tag --list "$1" --sort=v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'
}

# 1. Refuse to publish an image that doesn't match a committed tree.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: repo has uncommitted changes; commit or stash before publishing." >&2
  git status --short >&2
  exit 1
fi

# 2. Image tags: the commit hash, every git tag on HEAD, and the moving major/minor
#    aliases of each release tag (v0.1.10 -> v0.1, v0). ECR Public tags are mutable,
#    so re-pushing an alias re-points it; the image it displaces keeps its own exact
#    version tag. An alias only moves forward — publishing an older release leaves
#    the aliases on the newer one.
HASH="$(git rev-parse --short HEAD)"
TAGS=("$HASH")
while IFS= read -r tag; do
  TAGS+=("$tag")
  [[ "$tag" =~ ^v([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || continue
  major="v${BASH_REMATCH[1]}"
  for alias in "${major}.${BASH_REMATCH[2]}" "$major"; do
    if [ "$(releases "${alias}.*" | tail -1)" = "$tag" ]; then
      TAGS+=("$alias")
    else
      echo "note: leaving ${alias} alone; ${tag} is not the newest release in that series" >&2
    fi
  done
done < <(git tag --points-at HEAD)

LOCAL="${IMAGE}:${HASH}"

# 3. Authenticate Docker to the public ECR registry.
aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"

# 4. Build the image for amd64 (deployment target; Cirro ECR runs on x86_64).
#    Context is the repo root; Dockerfile lives under docker/.
docker build --platform linux/amd64 -f docker/Dockerfile -t "$LOCAL" .

# 5. Tag and push once per image tag.
for tag in "${TAGS[@]}"; do
  remote="${REGISTRY}/${IMAGE}:${tag}"
  docker tag "$LOCAL" "$remote"
  docker push "$remote"
  echo "pushed ${remote}"
done
