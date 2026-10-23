#!/usr/bin/env bash
# Deploys Sew Swap to Cloud Run + Firestore: ./deploy.sh
#
# Safe to run again: it skips what already exists and redeploys both services, so this is also
# how you ship updates. Answers are saved in deploy.env (no secrets; those go to Secret Manager).
# To use a custom domain later, add APP_BASE_URL=https://your.domain to deploy.env.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG=deploy.env
API=sew-swap-api
WEB=sew-swap-web

step() { printf '\n==> %s\n' "$*"; }

# ask VAR "question" [default]: skipped when VAR is already set (from deploy.env).
ask() {
  local var=$1 question=$2 default=${3-} answer
  [ -n "${!var-}" ] && return
  read -r -p "$question${default:+ [$default]}: " answer
  printf -v "$var" '%s' "${answer:-$default}"
}

# Retries a command a few times: new service accounts take a moment to become usable in IAM.
retry() {
  for _ in 1 2 3 4 5; do
    "$@" && return
    echo "  (retrying in 10s)"
    sleep 10
  done
  return 1
}

if ! command -v gcloud >/dev/null; then
  echo "The gcloud CLI isn't installed. Install it with:  brew install --cask google-cloud-sdk"
  echo "(or see https://cloud.google.com/sdk/docs/install), then run ./deploy.sh again."
  exit 1
fi
gcloud auth print-access-token >/dev/null 2>&1 || gcloud auth login

# shellcheck source=/dev/null
[ -f "$CONFIG" ] && source "$CONFIG"

step "Settings (saved in $CONFIG; edit or delete that file to change them)"
ask PROJECT "GCP project id" "$(gcloud config get-value project 2>/dev/null)"
ask REGION "Region" us-central1
ask ADMIN_EMAILS "Admin emails, comma-separated" "$(gcloud config get-value account 2>/dev/null)"
echo
echo "Email is sent through SMTP. For testing, Gmail works: turn on 2-step verification, then create"
echo "an App Password at https://myaccount.google.com/apppasswords (host smtp.gmail.com, port 465)."
ask SMTP_HOST "SMTP host" smtp.gmail.com
ask SMTP_PORT "SMTP port" 465
ask SMTP_USER "SMTP username (for Gmail, your Gmail address)"
ask MAIL_FROM "From address (Gmail requires your own address)" "Sew Swap <$SMTP_USER>"
echo
echo "Google sign-in is optional. Leave this blank to skip it for now; you'll be asked again next run."
ask GOOGLE_CLIENT_ID "Google OAuth client id"

cat >"$CONFIG" <<EOF
# Settings for ./deploy.sh (no secrets). Delete a line to be asked again.
$(for v in PROJECT REGION ADMIN_EMAILS SMTP_HOST SMTP_PORT SMTP_USER MAIL_FROM GOOGLE_CLIENT_ID APP_BASE_URL; do
  [ -n "${!v-}" ] && printf '%s=%q\n' "$v" "${!v}"
done)
EOF

# Every gcloud call below uses this project and takes default answers instead of prompting.
export CLOUDSDK_CORE_PROJECT=$PROJECT
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA=$API@$PROJECT.iam.gserviceaccount.com
APP_BASE_URL=${APP_BASE_URL:-https://$WEB-$NUM.$REGION.run.app}

step "Turning on the Google Cloud services (the first run takes a minute or two)"
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com compute.googleapis.com

step "Firestore database"
if gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  echo "Already exists."
else
  gcloud firestore databases create --location="$REGION"
  # Delete expired rows automatically (the API ignores expired ones anyway).
  for c in sessions loginTokens instagramChecks; do
    gcloud firestore fields ttls update ExpiresAt --collection-group="$c" --enable-ttl --async
  done
fi

step "Service accounts"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$API" --display-name="Sew Swap API"
retry gcloud projects add-iam-policy-binding "$PROJECT" --condition=None \
  --member="serviceAccount:$SA" --role=roles/datastore.user >/dev/null
# Deploying from source builds the images with the default compute service account.
retry gcloud projects add-iam-policy-binding "$PROJECT" --condition=None \
  --member="serviceAccount:$NUM-compute@developer.gserviceaccount.com" --role=roles/run.builder >/dev/null

# secret NAME "prompt": asks for the value only the first time, then lets the API read it.
secret() {
  if ! gcloud secrets describe "$1" >/dev/null 2>&1; then
    local value
    read -r -s -p "$2: " value
    echo
    printf '%s' "$value" | gcloud secrets create "$1" --data-file=-
  fi
  retry gcloud secrets add-iam-policy-binding "$1" --condition=None \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
}

step "Secrets (stored in Secret Manager; you're only asked once)"
if ! gcloud secrets describe auth-secret >/dev/null 2>&1; then
  openssl rand -base64 48 | tr -d '\n' | gcloud secrets create auth-secret --data-file=-
fi
secret auth-secret ""
secret smtp-pass "SMTP password (for Gmail, the App Password; typing is hidden)"
SECRETS=AUTH_SECRET=auth-secret:latest,SMTP_PASS=smtp-pass:latest
if [ -n "${GOOGLE_CLIENT_ID-}" ]; then
  secret google-client-secret "Google OAuth client secret (typing is hidden)"
  SECRETS=$SECRETS,GOOGLE_CLIENT_SECRET=google-client-secret:latest
fi

# A YAML file keeps commas and spaces in values (ADMIN_EMAILS, MAIL_FROM) intact.
ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
yaml() { printf '%s: "%s"\n' "$1" "$(printf '%s' "$2" | sed 's/[\\"]/\\&/g')" >>"$ENV_FILE"; }
yaml GOOGLE_CLOUD_PROJECT "$PROJECT"
yaml APP_BASE_URL "$APP_BASE_URL"
yaml ADMIN_EMAILS "$ADMIN_EMAILS"
yaml SMTP_HOST "$SMTP_HOST"
yaml SMTP_PORT "$SMTP_PORT"
yaml SMTP_USER "$SMTP_USER"
yaml MAIL_FROM "$MAIL_FROM"
[ -n "${GOOGLE_CLIENT_ID-}" ] && yaml GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"

step "Building and deploying the API (a few minutes)"
gcloud run deploy "$API" --source apps/api --region "$REGION" --service-account "$SA" \
  --allow-unauthenticated --env-vars-file "$ENV_FILE" --set-secrets "$SECRETS"
API_URL=$(gcloud run services describe "$API" --region "$REGION" --format='value(status.url)')

step "Building and deploying the website (a few minutes)"
gcloud run deploy "$WEB" --source apps/web --region "$REGION" \
  --allow-unauthenticated --set-env-vars "API_UPSTREAM=$API_URL"

step "Checking the site"
if curl -fsS "$APP_BASE_URL/api/health" >/dev/null; then
  echo "The site is up."
else
  echo "The health check failed. See the API logs with:"
  echo "  gcloud run services logs read $API --region $REGION --project $PROJECT --limit 50"
fi

cat <<EOF

Done. Open $APP_BASE_URL and sign in with $ADMIN_EMAILS.
EOF
if [ -n "${GOOGLE_CLIENT_ID-}" ]; then
  cat <<EOF
Google sign-in: make sure the OAuth client lists this authorized redirect URI:
  $APP_BASE_URL/api/auth/google/callback
EOF
else
  cat <<EOF
To add Google sign-in: in the console, open Google Auth Platform, set up Branding and Audience,
then create a "Web application" client with this authorized redirect URI:
  $APP_BASE_URL/api/auth/google/callback
Then run ./deploy.sh again and paste the client id and secret.
EOF
fi
