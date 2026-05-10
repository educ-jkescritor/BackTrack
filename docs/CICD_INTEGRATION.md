# BackTrack — CI/CD Integration

Integrating BackTrack with your CI/CD pipeline gives it the richest deployment context — exact git SHA, image tag, and service name — before your deployment even starts. This is Tier 1 detection: the fastest and most accurate.

## How it works

Your pipeline sends a single webhook after pushing a new image:

```
POST http://<backtrack-agent>:8847/deployment/notify
Content-Type: application/json

{ "service": "my-app", "image": "registry/my-app:abc1234", "git_sha": "abc1234" }
```

BackTrack immediately:
1. Creates a PENDING version snapshot with the git SHA
2. Resets anomaly counters for the service
3. Begins the stability window
4. Fires rollback automatically if TSD/LSI anomalies appear during the window

## Webhook payload

| Field | Required | Description |
|---|---|---|
| `service` | Yes | Service/deployment name (must match the monitored name) |
| `image` | No | Full image reference (`registry/name:tag`) |
| `git_sha` | No | Git commit SHA (used for rollback audit trail) |

## Environment variables

Set these on the BackTrack agent:

| Variable | Description |
|---|---|
| `BACKTRACK_GIT_WEBHOOK_URL` | URL BackTrack calls **after** a rollback completes |
| `BACKTRACK_GIT_WEBHOOK_SECRET` | HMAC-SHA256 secret for verifying outbound rollback webhooks |
| `BACKTRACK_GIT_SHA` | Git SHA at agent startup (used for the initial PENDING snapshot) |

## GitHub Actions

```yaml
# .github/workflows/deploy.yml
- name: Notify BackTrack
  if: success()
  run: |
    curl -sf -X POST "${{ secrets.BACKTRACK_AGENT_URL }}/deployment/notify" \
      -H "Content-Type: application/json" \
      -d '{
        "service": "${{ env.SERVICE_NAME }}",
        "image": "${{ env.IMAGE }}:${{ github.sha }}",
        "git_sha": "${{ github.sha }}"
      }'
```

```yaml
# Full example with build → push → deploy → notify
name: Deploy
on:
  push:
    branches: [main]

env:
  SERVICE_NAME: my-app
  REGISTRY: ghcr.io/my-org

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push image
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.SERVICE_NAME }}:${{ github.sha }}
          labels: org.opencontainers.image.revision=${{ github.sha }}

      - name: Deploy (kubectl / helm / etc.)
        run: kubectl set image deployment/${{ env.SERVICE_NAME }} \
               ${{ env.SERVICE_NAME }}=${{ env.REGISTRY }}/${{ env.SERVICE_NAME }}:${{ github.sha }} \
               -n production

      - name: Notify BackTrack
        if: success()
        run: |
          curl -sf -X POST "${{ secrets.BACKTRACK_AGENT_URL }}/deployment/notify" \
            -H "Content-Type: application/json" \
            -d '{
              "service": "${{ env.SERVICE_NAME }}",
              "image": "${{ env.REGISTRY }}/${{ env.SERVICE_NAME }}:${{ github.sha }}",
              "git_sha": "${{ github.sha }}"
            }'
```

## GitLab CI

```yaml
# .gitlab-ci.yml
notify-backtrack:
  stage: deploy
  script:
    - |
      curl -sf -X POST "$BACKTRACK_AGENT_URL/deployment/notify" \
        -H "Content-Type: application/json" \
        -d "{
          \"service\": \"$SERVICE_NAME\",
          \"image\": \"$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA\",
          \"git_sha\": \"$CI_COMMIT_SHA\"
        }"
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

## Jenkins

```groovy
// Jenkinsfile
stage('Notify BackTrack') {
    steps {
        script {
            def payload = groovy.json.JsonOutput.toJson([
                service: env.SERVICE_NAME,
                image  : "${env.REGISTRY}/${env.SERVICE_NAME}:${env.GIT_COMMIT}",
                git_sha: env.GIT_COMMIT,
            ])
            sh """
                curl -sf -X POST ${env.BACKTRACK_AGENT_URL}/deployment/notify \
                  -H 'Content-Type: application/json' \
                  -d '${payload}'
            """
        }
    }
}
```

## Outbound rollback webhook

When BackTrack rolls back a deployment, it can call your CI/CD system to create a revert PR or annotate the failed deploy. Configure it with:

```bash
BACKTRACK_GIT_WEBHOOK_URL=https://hooks.example.com/rollback
BACKTRACK_GIT_WEBHOOK_SECRET=your-secret-here
```

The webhook payload:

```json
{
  "event": "rollback",
  "service": "my-app",
  "reason": "TSD+LSI anomaly on my-app for 3 cycles",
  "from_image": "registry/my-app:bad-sha",
  "to_image":   "registry/my-app:good-sha",
  "from_sha":   "bad1234",
  "to_sha":     "good567",
  "triggered_at": "2026-05-05T14:32:00Z"
}
```

The signature is in the `X-BackTrack-Signature-256` header:

```
X-BackTrack-Signature-256: sha256=<hmac-sha256-hex>
```

Verify it in your webhook receiver:

```python
import hashlib, hmac

def verify(secret: str, body: bytes, sig_header: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_header)
```

## Baking OCI labels into your images

If you add the standard OCI revision label to your image, BackTrack can extract the git SHA automatically even **without** the notify webhook (Tier 2/3 detection):

```dockerfile
ARG GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
```

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t my-app:latest .
```

## Verifying the integration

```bash
# Manually fire a test notification
curl -X POST http://localhost:8847/deployment/notify \
  -H "Content-Type: application/json" \
  -d '{"service": "my-app", "image": "my-app:test", "git_sha": "abc1234"}'

# Confirm snapshot was created
curl http://localhost:8847/versions | jq '.[0]'
# Should show { "status": "PENDING", "git_sha": "abc1234", ... }
```
