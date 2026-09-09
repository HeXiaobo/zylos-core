#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Zylos One-Click Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/HeXiaobo/zylos-core/main/scripts/install.sh | bash
#
# Install from a specific branch:
#   curl -fsSL https://raw.githubusercontent.com/HeXiaobo/zylos-core/main/scripts/install.sh | bash -s -- --branch <branch-name>
#
# Full non-interactive deployment:
#   curl -fsSL .../install.sh | bash -s -- -y --setup-token sk-ant-oat01-xxx --domain example.com --https
#
# Install with Codex runtime:
#   curl -fsSL .../install.sh | bash -s -- -y --runtime codex --domain example.com --https
#
# Install with custom API base URLs:
#   curl -fsSL .../install.sh | bash -s -- -y --base-url https://claude-proxy.example.com
#   curl -fsSL .../install.sh | bash -s -- -y --runtime codex --codex-base-url https://proxy.example.com/v1
#
# Install environment only (no init):
#   curl -fsSL .../install.sh | bash -s -- --no-init
#
# Supported platforms: Linux (Debian/Ubuntu/RHEL), macOS
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Wrap entire script in a block so bash must read all of it
# before executing anything — protects against partial downloads
# when piped via curl | bash.
_main() {

# ── Parse Arguments ───────────────────────────────────────────
BRANCH=""
RELEASE_VERSION="latest"
RELEASE_CHANNEL="stable"
UPGRADED_EXISTING=false
KEEP_EXISTING=false
NO_INIT=false
INIT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --branch|-b)
      if [ -z "${2:-}" ]; then
        echo "[zylos] Error: --branch requires a value" >&2
        exit 1
      fi
      BRANCH="$2"
      shift 2
      ;;
    --version|--channel)
      if [ -z "${2:-}" ]; then
        echo "[zylos] Error: $1 requires a value" >&2
        exit 1
      fi
      if [ "$1" = "--version" ]; then RELEASE_VERSION="$2"; else RELEASE_CHANNEL="$2"; fi
      shift 2
      ;;
    --no-init)
      NO_INIT=true
      shift
      ;;
    # Flags that take a value — forward both flag and value to zylos init
    --timezone|--setup-token|--api-key|--codex-api-key|--base-url|--codex-base-url|--domain|--web-password|--runtime)
      if [ -z "${2:-}" ]; then
        echo "[zylos] Error: $1 requires a value" >&2
        exit 1
      fi
      INIT_ARGS+=("$1" "$2")
      shift 2
      ;;
    # Boolean flags — forward as-is to zylos init
    -y|--yes|-q|--quiet|--https|--no-https|--caddy|--no-caddy|-h|--help)
      INIT_ARGS+=("$1")
      shift
      ;;
    # Combined short flags (e.g., -yq) — only allow [yqh] characters
    -[yqh][yqh]|-[yqh][yqh][yqh])
      INIT_ARGS+=("$1")
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# ── Configuration ─────────────────────────────────────────────
ZYLOS_REPO_SLUG="${ZYLOS_SELF_UPGRADE_REPO:-HeXiaobo/zylos-core}"
if [[ ! "$ZYLOS_REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "[zylos] Error: ZYLOS_SELF_UPGRADE_REPO must be an owner/repo slug" >&2
  exit 1
fi
ZYLOS_REPO="https://github.com/${ZYLOS_REPO_SLUG}"
NODE_VERSION="24"               # LTS-track major version
MIN_NODE_MAJOR=20
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"

# ── Colors (disabled if not a terminal) ───────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BCYAN='\033[1;36m'
  DIM='\033[2m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BCYAN='' DIM='' BOLD='' NC=''
fi

info()  { printf "${CYAN}[zylos]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[zylos]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[zylos]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[zylos]${NC} %s\n" "$*" >&2; exit 1; }

# Release selection is performed after Node is available, using the same
# standalone resolver as all three repository-linked upgrade entrypoints.
# --branch is an explicit developer/operator path, never a failure fallback.
if [ "$RELEASE_CHANNEL" != "stable" ] && [ "$RELEASE_CHANNEL" != "preview" ]; then
  fail "--channel must be stable or preview"
fi
if [ -n "$BRANCH" ] && { [ "$RELEASE_VERSION" != "latest" ] || [ "$RELEASE_CHANNEL" != "stable" ]; }; then
  fail "Do not combine an explicit developer --branch with release selection"
fi

resolve_install_release() {
  if [ -n "$BRANCH" ]; then
    warn "Explicit developer source selected; this is not the verified release channel."
    # Freeze even an explicitly selected branch/tag before the npm operation.
    local ref_dir
    (umask 077; mkdir -p "${HOME}/.cache/zylos")
    ref_dir="$(mktemp -d "${HOME}/.cache/zylos/install-ref.XXXXXX")"
    git -C "$ref_dir" init -q
    git -C "$ref_dir" fetch -q --depth=1 -- "$ZYLOS_REPO" "$BRANCH"
    BRANCH="$(git -C "$ref_dir" rev-parse FETCH_HEAD)"
    return
  fi
  if [ "$ZYLOS_REPO_SLUG" != "HeXiaobo/zylos-core" ]; then
    fail "The verified fork channel belongs to HeXiaobo/zylos-core; use the selected repository's documented installer."
  fi
  local operator_sha control_dir
  local runtime_args=()
  local argument_index
  for ((argument_index=0; argument_index<${#INIT_ARGS[@]}; argument_index++)); do
    if [ "${INIT_ARGS[$argument_index]}" = "--runtime" ]; then
      runtime_args=(--runtime "${INIT_ARGS[$((argument_index + 1))]}")
    fi
  done
  operator_sha="$(git ls-remote "$ZYLOS_REPO" refs/heads/main | awk '$2 == "refs/heads/main" { print $1 }')"
  if [[ ! "$operator_sha" =~ ^[a-f0-9]{40}$ ]]; then fail "Cannot pin trusted installer tools"; fi
  control_dir="${HOME}/.cache/zylos/install-$(date +%s)-$$"
  (umask 077; mkdir -p "$control_dir")
  printf '%s\n' "$operator_sha" > "$control_dir/operator-sha.txt"
  curl -fsSL "https://raw.githubusercontent.com/${ZYLOS_REPO_SLUG}/${operator_sha}/tools/upgrade/release-channel.mjs" -o "$control_dir/release-channel.mjs"
  BRANCH="$(node "$control_dir/release-channel.mjs" --component core --version "$RELEASE_VERSION" --channel "$RELEASE_CHANNEL" --out "$control_dir/selection.json" ${runtime_args[@]+"${runtime_args[@]}"} --sha-only)"
  if [[ ! "$BRANCH" =~ ^[a-f0-9]{40}$ ]]; then fail "No verified install source selected"; fi
  if command -v zylos &>/dev/null; then
    local current_version
    current_version="$(zylos --version)"
    local comparison
    comparison="$(node --input-type=module - "$control_dir/release-channel.mjs" "$control_dir/selection.json" "$current_version" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { compareVersions } = await import(pathToFileURL(process.argv[2]).href);
const selected = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
console.log(compareVersions(process.argv[4].trim().replace(/^v/, ''), selected.target.version));
NODE
)"
    if [ "$comparison" -ge 0 ]; then KEEP_EXISTING=true; fi
  fi
  info "Verified source: ${BRANCH}; receipt: $control_dir/selection.json"
}

# ── OS Detection ──────────────────────────────────────────────
detect_os() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)  OS="linux" ;;
    Darwin) OS="macos" ;;
    *)      fail "Unsupported operating system: $OS. Try installing via SSH: claude --ssh user@linux-server" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)             fail "Unsupported architecture: $ARCH" ;;
  esac

  info "Detected: $OS ($ARCH)"
}

# ── Package Manager ───────────────────────────────────────────
APT_UPDATED=false

install_system_package() {
  local pkg="$1"
  info "Installing $pkg..."

  if [ "$OS" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      fail "Homebrew not found. Install it first: https://brew.sh"
    fi
    brew install "$pkg"
  elif [ "$OS" = "linux" ]; then
    # Use sudo if not root; skip if already root (e.g., Docker containers)
    local SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
      if ! command -v sudo &>/dev/null; then
        fail "sudo not found and not running as root. Please install $pkg manually as root, then re-run this script."
      fi
      SUDO="sudo"
    fi
    if command -v apt-get &>/dev/null; then
      if [ "$APT_UPDATED" = false ]; then
        $SUDO apt-get update -qq
        APT_UPDATED=true
      fi
      $SUDO apt-get install -y -qq "$pkg"
    elif command -v dnf &>/dev/null; then
      $SUDO dnf install -y "$pkg"
    elif command -v yum &>/dev/null; then
      $SUDO yum install -y "$pkg"
    else
      fail "No supported package manager found (apt-get, dnf, yum). Please install $pkg manually."
    fi
  fi
}

# ── Prerequisite: curl ────────────────────────────────────────
ensure_curl() {
  if command -v curl &>/dev/null; then
    return
  fi
  install_system_package curl
  ok "curl: installed"
}

# ── Prerequisite: git ─────────────────────────────────────────
ensure_git() {
  if command -v git &>/dev/null; then
    ok "git: $(git --version | head -1)"
    return
  fi
  install_system_package git
  ok "git: installed"
}

# ── Prerequisite: tmux ────────────────────────────────────────
ensure_tmux() {
  if command -v tmux &>/dev/null; then
    ok "tmux: $(tmux -V)"
    return
  fi
  install_system_package tmux
  ok "tmux: installed"
}

# ── Prerequisite: Node.js (via nvm) ──────────────────────────
ensure_node() {
  # Check if Node.js + npm exist and meet minimum version
  if command -v node &>/dev/null && command -v npm &>/dev/null; then
    local current_major
    current_major="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [ "$current_major" -ge "$MIN_NODE_MAJOR" ]; then
      ok "node: $(node -v) (meets >= v${MIN_NODE_MAJOR} requirement)"
      return
    fi
    warn "node: $(node -v) is below minimum v${MIN_NODE_MAJOR}, upgrading..."
  elif command -v node &>/dev/null; then
    warn "node found but npm is missing, installing via nvm..."
  fi

  # Install or load nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "Installing nvm..."
    curl -fsSL "$NVM_INSTALL_URL" | bash
  fi

  # Load nvm into current shell
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"

  info "Installing Node.js v${NODE_VERSION} via nvm..."
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"

  ok "node: $(node -v)"
}

# ── Ensure PATH in shell profile ─────────────────────────────
# Auto-add necessary bin directories to the user's shell profile so
# zylos, pm2, and claude are available in new terminal sessions.
# Called independently of zylos init — acts as a safety net.
_ensure_path_in_profile() {
  # Determine shell rc file (fish uses a different config mechanism)
  local shell_rc is_fish=false
  case "${SHELL:-}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    */fish) is_fish=true ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac

  mkdir -p "$HOME/.local/bin" "$HOME/zylos/bin"

  if [ "$is_fish" = true ]; then
    # Fish uses a different syntax and config path
    local fish_conf_dir="$HOME/.config/fish/conf.d"
    mkdir -p "$fish_conf_dir"
    local fish_conf="$fish_conf_dir/zylos.fish"
    if [ ! -f "$fish_conf" ]; then
      cat > "$fish_conf" <<'FISH_EOF'
# Added by zylos installer
fish_add_path -g $HOME/.local/bin
fish_add_path -g $HOME/zylos/bin
FISH_EOF
      ok "PATH configured in conf.d/zylos.fish"
    fi
  else
    # 1. ~/.local/bin — claude installs here
    #    Idempotency: grep for uncommented ".local/bin" (skip commented-out lines)
    # shellcheck disable=SC2016
    local local_bin_export='export PATH="$HOME/.local/bin:$PATH"'
    if ! grep -q '^[^#]*\.local/bin' "$shell_rc" 2>/dev/null; then
      printf '\n# Added by zylos installer\n%s\n' "$local_bin_export" >> "$shell_rc"
    fi

    # 2. ~/zylos/bin — component CLIs (caddy, etc.)
    #    Idempotency: grep for "zylos-managed: bin PATH" marker (matches init.js pattern)
    local zylos_marker='# zylos-managed: bin PATH'
    local zylos_bin_export="export PATH=\"\$HOME/zylos/bin:\$PATH\""

    # Write to ~/.profile (login shells + non-interactive shells)
    if ! grep -q 'zylos-managed: bin PATH' "$HOME/.profile" 2>/dev/null; then
      printf '\n%s\n%s\n' "$zylos_marker" "$zylos_bin_export" >> "$HOME/.profile"
    fi
    # Write to shell rc file (interactive shells)
    if [ "$shell_rc" != "$HOME/.profile" ]; then
      if ! grep -q 'zylos-managed: bin PATH' "$shell_rc" 2>/dev/null; then
        printf '\n%s\n%s\n' "$zylos_marker" "$zylos_bin_export" >> "$shell_rc"
      fi
    fi

    ok "PATH configured in $(basename "$shell_rc")"
  fi

  # Export for the running script (so zylos init can find binaries)
  export PATH="$HOME/.local/bin:$HOME/zylos/bin:$PATH"
}

# ── Install Zylos ─────────────────────────────────────────────
install_zylos() {
  if [ "$KEEP_EXISTING" = true ]; then
    info "Installed Core is at the selected version or newer; preserving its source without reinstalling."
    UPGRADED_EXISTING=true
    return
  fi
  if command -v zylos &>/dev/null; then
    local current_version
    current_version="$(zylos --version 2>/dev/null || echo 'unknown')"
    info "zylos is already installed (${current_version}); using its backup/rollback upgrader..."
    zylos upgrade --self --repo "$ZYLOS_REPO_SLUG" --branch "$BRANCH" --yes
    UPGRADED_EXISTING=true
    return
  fi

  local install_url="${ZYLOS_REPO}#${BRANCH}"
  info "Installing zylos from GitHub (${BRANCH})..."

  # If npm global prefix is not user-writable (system-installed node),
  # use sudo for npm install -g
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
  if [ -n "$npm_prefix" ] && [ -w "$npm_prefix" ]; then
    npm install -g --install-links --ignore-scripts "$install_url"
  else
    warn "npm global directory (${npm_prefix:-unknown}) requires elevated permissions, using sudo..."
    if [ "$(id -u)" -eq 0 ]; then
      npm install -g --install-links --ignore-scripts "$install_url"
    else
      sudo npm install -g --install-links --ignore-scripts "$install_url"
    fi
  fi

  ok "zylos: $(zylos --version 2>/dev/null || echo 'installed')"
}

# ── Entry Point ───────────────────────────────────────────────
echo ""
printf '%b' "${BCYAN}"
echo "  ███████╗██╗   ██╗██╗      ██████╗ ███████╗"
echo "  ╚══███╔╝╚██╗ ██╔╝██║     ██╔═══██╗██╔════╝"
echo "    ███╔╝  ╚████╔╝ ██║     ██║   ██║███████╗"
printf '%b' "${CYAN}"
echo "   ███╔╝    ╚██╔╝  ██║     ██║   ██║╚════██║"
echo "  ███████╗   ██║   ███████╗╚██████╔╝███████║"
echo "  ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝ ╚══════╝"
printf '%b' "${NC}"
echo ""
printf '%b' "  ${BOLD}Give your AI a life.${NC}"
echo ""
echo ""

# Warn if running as root (nvm and zylos should run as a normal user)
if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root is not recommended. Zylos and nvm work best under a regular user account."
  warn "Press Ctrl+C to abort, or wait 5 seconds to continue..."
  sleep 5
fi

detect_os

if [ -n "$BRANCH" ]; then
  info "Branch: ${BRANCH}"
fi

# ── Security Consent ─────────────────────────────────────────
# Show security notice before installing anything. Skip in non-interactive
# mode (-y) or when stdin is not a terminal (piped without /dev/tty).
_has_yes_flag() {
  for arg in "${INIT_ARGS[@]+"${INIT_ARGS[@]}"}"; do
    case "$arg" in -y|--yes|-yq|-qy|-yqh|-qyh|-hyq|-hqy|-yhq|-qhy) return 0 ;; esac
  done
  return 1
}

if ! _has_yes_flag && [ -t 0 -o -e /dev/tty ]; then
  echo ""
  printf '%b' "${YELLOW}${BOLD}"
  echo "  ◆ Security Notice"
  printf '%b' "${NC}"
  printf '%b' "${DIM}"
  echo "  ┌────────────────────────────────────────────────────────┐"
  echo "  │                                                        │"
  printf '%b' "${NC}"
  printf "  ${DIM}│${NC}  ${DIM}Zylos currently assumes a trusted environment.${NC}     ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${DIM}It runs with full system access as the current${NC}     ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${DIM}user — it can execute commands, read/write${NC}          ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${DIM}files, and access the network on your behalf.${NC}      ${DIM}│${NC}\n"
  printf '%b' "${DIM}"
  echo "  │                                                        │"
  printf '%b' "${NC}"
  printf "  ${DIM}│${NC}  ${YELLOW}⚠ Dangerous: If untrusted people can reach${NC}         ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${YELLOW}this machine or talk to the bot, they can${NC}          ${DIM}│${NC}\n"
  printf "  ${DIM}│${NC}  ${YELLOW}execute anything as your user.${NC}                     ${DIM}│${NC}\n"
  printf '%b' "${DIM}"
  echo "  │                                                        │"
  echo "  └────────────────────────────────────────────────────────┘"
  printf '%b' "${NC}"
  echo ""
  echo "  Only continue if you understand the risks and trust"
  echo "  the environment you are installing on."
  echo ""
  printf '%b' "${BOLD}"
  printf "  I understand and want to continue [Y/n]: "
  printf '%b' "${NC}"
  if [ -e /dev/tty ]; then
    read -r answer < /dev/tty
  else
    read -r answer
  fi
  case "${answer:-Y}" in
    [Yy]*|"")
      # User accepted — tell zylos init to skip its own consent prompt
      INIT_ARGS+=("--skip-consent")
      ;;
    *)
      echo ""
      info "Installation cancelled. No changes were made."
      echo ""
      exit 0
      ;;
  esac
fi

echo ""
info "Checking prerequisites..."
echo ""

ensure_curl
ensure_git
ensure_tmux
ensure_node
resolve_install_release

echo ""
install_zylos
if [ "$UPGRADED_EXISTING" = true ]; then return 0; fi

echo ""
_ensure_path_in_profile
echo ""
ok "Installation complete!"
echo ""

# Detect the user's shell rc file
_detect_shell_rc() {
  case "${SHELL:-}" in
    */zsh)  echo "~/.zshrc" ;;
    */bash) echo "~/.bashrc" ;;
    */fish) echo "" ;;
    *)      echo "~/.profile" ;;
  esac
}

# Show the post-install hint for activating PATH in the current terminal.
# Styled as a separator + prominent command, not a box (avoids clashing with
# zylos init's own boxed output).
_show_source_hint() {
  local shell_rc
  shell_rc="$(_detect_shell_rc)"

  echo ""
  printf '%b' "${CYAN}"
  echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf '%b' "${NC}"
  echo ""
  if [ -n "$shell_rc" ]; then
    printf '%b' "${BOLD}"
    echo "  To activate zylos commands in this terminal:"
    printf '%b' "${NC}"
    echo ""
    printf '%b' "${GREEN}${BOLD}"
    echo "    source $shell_rc"
    printf '%b' "${NC}"
  else
    printf '%b' "${BOLD}"
    echo "  To activate zylos commands, open a new terminal."
    printf '%b' "${NC}"
  fi
  echo ""
  info "New terminal sessions will work automatically."
  echo ""
}

if [ "$NO_INIT" = true ]; then
  local shell_rc
  shell_rc="$(_detect_shell_rc)"
  info "Skipping zylos init (--no-init)."
  echo ""
  if [ -n "$shell_rc" ]; then
    info "To initialize later, open a new terminal or run:"
    echo ""
    echo "    source $shell_rc && zylos init"
  else
    info "To initialize later, open a new terminal and run:"
    echo ""
    echo "    zylos init"
  fi
  echo ""
else
  # Always run zylos init after installation (environment is ready at this point).
  info "Running zylos init..."
  echo ""
  local init_exit=0
  if [ -e /dev/tty ]; then
    zylos init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} < /dev/tty || init_exit=$?
  else
    zylos init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} || init_exit=$?
  fi

  if [ "$init_exit" -eq 0 ]; then
    _show_source_hint
  else
    echo ""
  fi
fi

} # end of _main — do not remove (partial download guard)

_main "$@"
