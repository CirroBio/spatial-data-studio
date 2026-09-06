#!/usr/bin/env bash
# Build and push the Spatial Data Studio image to the Cirro public ECR, tagged
# with the current git commit hash and with any git tags pointing at that commit.
set -euo pipefail

REGISTRY="public.ecr.aws/cirrobio"
IMAGE="spatial-data-studio"

# 1. Refuse to publish an image that doesn't match a committed tree.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: repo has uncommitted changes; commit or stash before publishing." >&2
  git status --short >&2
  exit 1
fi

# 2. Image tags: the commit hash, plus every git tag on HEAD (e.g. v1.2.3).
HASH="$(git rev-parse --short HEAD)"
TAGS=("$HASH")
while IFS= read -r tag; do
  TAGS+=("$tag")
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
