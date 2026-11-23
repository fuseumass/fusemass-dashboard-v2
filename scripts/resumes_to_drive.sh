#!/usr/bin/env bash
# Upload applicant resumes to a Google Drive folder.
#
#   scripts/resumes_to_drive.sh "https://drive.google.com/drive/folders/<id>" [--all] [--no-upload]
#
#   --all        every active applicant with a resume (default: accepted only)
#   --no-upload  just download to ~/Downloads/resumes-<date>, skip Google Drive
#
# What it does:
#   1. Runs scripts/export-resumes.js on the dashboard server, which copies each
#      resume out of private storage as Name_abc123.pdf plus index.csv
#      (name, status, education, university, major, file).
#   2. Streams them to ~/Downloads/resumes-<date> on this Mac and deletes the
#      copy on the server.
#   3. Uploads that folder into the Drive folder with rclone. Re-running only
#      uploads files that are new or changed.
#
# One-time setup on this Mac:
#   brew install rclone
#   The first upload opens a browser to sign in to the Google account that
#   can edit the Drive folder (rclone remote "hackdash-drive").
#
# Server access: the .pem key in the repo root (override with KEY=..., HOST=...).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${KEY:-$REPO/DashboardM1_key.pem}"
HOST="${HOST:-hum@20.40.56.207}"
BACKEND="${BACKEND:-/opt/hackdash/backend}"
REMOTE="${RCLONE_REMOTE:-hackdash-drive}"

LINK=""
SCOPE=""
UPLOAD=1
for arg in "$@"; do
  case "$arg" in
    --all) SCOPE="--all" ;;
    --no-upload) UPLOAD=0 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) LINK="$arg" ;;
  esac
done

# Folder id from any Drive folder link: .../folders/<id>, ...?id=<id>, or a bare id.
FOLDER_ID=""
if [[ "$LINK" =~ /folders/([A-Za-z0-9_-]+) ]]; then FOLDER_ID="${BASH_REMATCH[1]}"
elif [[ "$LINK" =~ [?\&]id=([A-Za-z0-9_-]+) ]]; then FOLDER_ID="${BASH_REMATCH[1]}"
elif [[ "$LINK" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then FOLDER_ID="$LINK"
fi
if [[ "$UPLOAD" == 1 && -z "$FOLDER_ID" ]]; then
  echo "Give a Google Drive folder link, e.g. https://drive.google.com/drive/folders/1AbC..." >&2
  echo "(or --no-upload to only download)" >&2
  exit 2
fi
[[ -f "$KEY" ]] || { echo "Server key not found: $KEY" >&2; exit 2; }
if [[ "$UPLOAD" == 1 ]] && ! command -v rclone >/dev/null; then
  echo "rclone is needed for the Drive upload: brew install rclone   (or run with --no-upload)" >&2
  exit 2
fi

STAMP="$(date +%Y-%m-%d-%H%M)"
LOCAL="$HOME/Downloads/resumes-$STAMP"
mkdir -p "$LOCAL"
SSH=(ssh -i "$KEY" -o ConnectTimeout=15 "$HOST")

echo "Exporting resumes on the server (${SCOPE:-accepted only})..."
scp -q -i "$KEY" "$REPO/scripts/export-resumes.js" "$HOST:$BACKEND/export-resumes.tmp.js"
# Export into a temp folder, stream it back as a tar, then always clean up the server copy.
"${SSH[@]}" "set -e; D=\$(mktemp -d); trap 'rm -rf \"\$D\" \"$BACKEND/export-resumes.tmp.js\"' EXIT;
  cd '$BACKEND' && node export-resumes.tmp.js \"\$D\" $SCOPE >&2 && tar -C \"\$D\" -cf - ." | tar -C "$LOCAL" -xf -

COUNT="$(find "$LOCAL/resumes" -type f | wc -l | tr -d ' ')"
echo "Downloaded $COUNT resumes to $LOCAL (index: $LOCAL/index.csv)"
[[ "$UPLOAD" == 1 ]] || exit 0

if ! rclone listremotes | grep -qx "$REMOTE:"; then
  echo "Connecting rclone to Google Drive (a browser window will open; sign in with an account that can edit the folder)..."
  rclone config create "$REMOTE" drive scope=drive >/dev/null
fi
echo "Uploading to Drive folder $FOLDER_ID ..."
rclone copy "$LOCAL" "$REMOTE:" --drive-root-folder-id "$FOLDER_ID" --progress --transfers 8
echo "Done: $COUNT resumes + index.csv are in https://drive.google.com/drive/folders/$FOLDER_ID"
