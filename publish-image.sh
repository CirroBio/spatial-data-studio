#!/usr/bin/env bash
# Build and push the Spatial Data Studio image to the Cirro public ECR,
# tagged with the current git commit hash.
set -euo pipefail

REGISTRY="public.ecr.aws/cirrobio"
IMAGE="spatial-data-studio"

# 1. Refuse to publish an image that doesn't match a committed tree.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: repo has uncommitted changes; commit or stash before publishing." >&2
  git status --short >&2
  exit 1
fi

# 2. Commit hash to tag the image with.
HASH="$(git rev-parse --short HEAD)"
LOCAL="${IMAGE}:${HASH}"
REMOTE="${REGISTRY}/${IMAGE}:${HASH}"

# 3. Authenticate Docker to the public ECR registry.
aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"

# 4. Build the image (context is the repo root; Dockerfile lives under docker/).
docker build -f docker/Dockerfile -t "$LOCAL" .

# 5. Tag it with the remote URI.
docker tag "$LOCAL" "$REMOTE"

# 6. Push.
docker push "$REMOTE"

echo "pushed ${REMOTE}"
