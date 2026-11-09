#!/usr/bin/env bash
# Tải ffmpeg (BtbN) + ab-av1 + gdown theo phiên bản ghim trong config/tools.json, rồi kiểm tra.
set -euo pipefail

TOOLS_DIR="${TOOLS_DIR:-$HOME/tools}"
BIN="$TOOLS_DIR/bin"
mkdir -p "$BIN"
cfg() { node -e 'const t=require("./config/tools.json");const p=process.argv[1].split(".");let v=t;for(const k of p)v=v?.[k];process.stdout.write(String(v??""))' "$1"; }
verify_sha() { # $1 file, $2 sha256 mong đợi (rỗng = bỏ qua)
  [ -z "$2" ] && return 0
  echo "$2  $1" | sha256sum -c - >/dev/null || { echo "::error::SHA256 không khớp: $1"; exit 1; }
}

FF_TAG="$(cfg ffmpeg.tag)"; FF_ASSET="$(cfg ffmpeg.asset)"; FF_REPO="$(cfg ffmpeg.repo)"
AB_TAG="$(cfg ab_av1.tag)"; AB_ASSET="$(cfg ab_av1.asset)"; AB_REPO="$(cfg ab_av1.repo)"
GDOWN_VER="$(cfg gdown.version)"
FF_FB_TAG="$(cfg ffmpeg.fallback_tag)"; FF_FB_ASSET="$(cfg ffmpeg.fallback_asset)"
FF_SHA="$(cfg ffmpeg.sha256)"; AB_SHA="$(cfg ab_av1.sha256)"
YT_REPO="$(cfg yt_dlp.repo)"; YT_TAG="$(cfg yt_dlp.tag)"; YT_ASSET="$(cfg yt_dlp.asset)"; YT_SHA="$(cfg yt_dlp.sha256)"
MARK="$TOOLS_DIR/.ok-$(sha256sum config/tools.json | cut -c1-12)"

if [ ! -f "$MARK" ]; then
  rm -rf "$BIN"/* "$TOOLS_DIR/dl"; mkdir -p "$TOOLS_DIR/dl"
  cd "$TOOLS_DIR/dl"

  echo "== ffmpeg $FF_TAG"
  if ! gh release download "$FF_TAG" --repo "$FF_REPO" --pattern "$FF_ASSET" 2>/dev/null; then
    echo "::warning::Tag ffmpeg $FF_TAG không còn (hoặc thiếu file). Dùng bản '$FF_FB_TAG' cùng nhánh. Hãy cập nhật config/tools.json."
    FF_ASSET="$FF_FB_ASSET"
    gh release download "$FF_FB_TAG" --repo "$FF_REPO" --pattern "$FF_ASSET"
  else
    verify_sha "$FF_ASSET" "$FF_SHA"
  fi
  tar -xJf "$FF_ASSET"
  cp "$(find . -type f -name ffmpeg -path '*/bin/*' | head -n1)" "$BIN/ffmpeg"
  cp "$(find . -type f -name ffprobe -path '*/bin/*' | head -n1)" "$BIN/ffprobe"
  rm -rf ./ffmpeg-*

  echo "== ab-av1 $AB_TAG"
  gh release download "$AB_TAG" --repo "$AB_REPO" --pattern "$AB_ASSET"
  verify_sha "$AB_ASSET" "$AB_SHA"
  command -v zstd >/dev/null || sudo apt-get install -y -qq zstd
  tar --zstd -xf "$AB_ASSET"
  cp "$(find . -type f -name ab-av1 | head -n1)" "$BIN/ab-av1"
  echo "== yt-dlp $YT_TAG"
  if ! gh release download "$YT_TAG" --repo "$YT_REPO" --pattern "$YT_ASSET" 2>/dev/null; then
    echo "::warning::Tag yt-dlp $YT_TAG không tải được. Dùng bản mới nhất. Hãy cập nhật config/tools.json."
    gh release download --repo "$YT_REPO" --pattern "$YT_ASSET"
  else
    verify_sha "$YT_ASSET" "$YT_SHA"
  fi
  cp "$YT_ASSET" "$BIN/yt-dlp"
  chmod +x "$BIN"/*
  cd "$TOOLS_DIR" && rm -rf dl && touch "$MARK"
fi

export PATH="$BIN:$HOME/.local/bin:$PATH"
echo "$BIN" >> "${GITHUB_PATH:-/dev/null}"
echo "$HOME/.local/bin" >> "${GITHUB_PATH:-/dev/null}"

echo "== gdown $GDOWN_VER"
pip install --user --quiet "gdown==$GDOWN_VER" || pip install --user --quiet --break-system-packages "gdown==$GDOWN_VER"

check_ffmpeg() {
  local enc filt
  enc="$(ffmpeg -hide_banner -encoders 2>/dev/null)" || return 1
  filt="$(ffmpeg -hide_banner -filters 2>/dev/null)" || return 1
  grep -q libsvtav1 <<<"$enc" && grep -q libx265 <<<"$enc" && grep -q libopus <<<"$enc" && grep -q libvmaf <<<"$filt"
}
if ! check_ffmpeg; then
  echo "::warning::ffmpeg tải về thiếu libsvtav1/libx265/libopus/libvmaf. Thử ffmpeg của Ubuntu."
  rm -f "$BIN/ffmpeg" "$BIN/ffprobe"; rm -f "$TOOLS_DIR"/.ok-*
  sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg
  hash -r
  check_ffmpeg || { echo "::error::ffmpeg không có đủ libsvtav1, libx265, libopus, libvmaf."; exit 1; }
fi
command -v ffprobe >/dev/null || { echo "::error::Thiếu ffprobe"; exit 1; }
ab-av1 --version || { echo "::error::ab-av1 không chạy được"; exit 1; }
gdown --version || { echo "::error::gdown không chạy được"; exit 1; }
yt-dlp --version || { echo "::error::yt-dlp không chạy được"; exit 1; }
ffmpeg -hide_banner -version 2>&1 | sed -n 1p
# Lưu --help của đúng phiên bản đã ghim để đối chiếu cờ khi có lỗi
for c in crf-search encode; do ab-av1 "$c" --help > "$TOOLS_DIR/help-$c.txt" 2>&1 || true; done
echo "Công cụ sẵn sàng."
