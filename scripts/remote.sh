#!/usr/bin/env bash
# Fetch a released job-kit bundle, then run the channel installers.
# Compatible with macOS Bash 3.2. Safe to pipe: curl -fsSL … | bash -s -- all
set -euo pipefail

JOB_KIT_SLUG="${JOB_KIT_SLUG:-rafaeelricco/job-kit}"
JOB_KIT_VERSION="${JOB_KIT_VERSION:-latest}"
JOB_KIT_HOME="${JOB_KIT_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/job-kit}"

# strip_trailing_slashes PATH
# Prints PATH with trailing slashes removed (a lone "/" is kept). Without this,
# a JOB_KIT_HOME value like `/path/to/link/` makes `[ -L ]` and `rm -rf` operate
# on the target directory instead of the symlink itself.
# Side effects: none.
strip_trailing_slashes() {
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "${p}" ]; do
    p="${p%/}"
  done
  printf '%s' "${p}"
}

JOB_KIT_HOME="$(strip_trailing_slashes "${JOB_KIT_HOME}")"

# usage
# Prints CLI help to stdout.
# Side effects: none.
usage() {
  cat <<'EOF'
Install or uninstall job-kit skills from a verified release bundle.

Usage: remote.sh [channel] [options…]
       remote.sh uninstall [target] [options…]

Install channels:
  all          Aside + coding agents + browser-use, skipping absent (default)
  aside        Aside only, macOS (fails off macOS, or when Aside is not set up)
  agents       Coding agents only (fails when no agent home exists)
  browser-use  job-scout + job-apply + job-prep plus the browser-use driver
               skill into coding-agent homes (needs an agent home), driven by
               the local browser-use CLI over your own browser
  fetch        Refresh the installed bundle, install no skills

Uninstall:
  uninstall              Aside + agent + browser-use skills (default: all)
  uninstall all          Same
  uninstall aside        Aside only
  uninstall agents       Coding agents only
  uninstall browser-use  job-scout + job-apply + job-prep links, the
                         browser-use driver skill, the CLI, and its state
                         (never your browser)

  Interactive (profile data + menu): bash scripts/uninstall.sh
  from a local checkout or installed bundle. Remote uninstall never deletes
  ~/.config/job-kit.

  -h, --help  Show this help

Install options after the channel are forwarded to the installer. The only
one is --dry-run.

Uninstall options:
  --purge             After full uninstall only, remove the installed bundle
                      (refused on a partial target such as `uninstall aside`,
                      while CLAUDE_SKILLS/ASIDE_SKILLS narrow a channel, and
                      over a pipe, which cannot type the required `yes` —
                      run it from a terminal against the installed bundle)

Environment:
  JOB_KIT_HOME     Installed bundle (default $XDG_DATA_HOME/job-kit)
  JOB_KIT_VERSION  Release tag vX.Y.Z, or latest (default latest stable release)
  JOB_KIT_SLUG     GitHub owner/repo (default rafaeelricco/job-kit)

JOB_KIT_REF is no longer supported when fetching. Use JOB_KIT_VERSION for a
published release, or run scripts/install.sh from a local source checkout.
Legacy source/Git caches are backed up beside JOB_KIT_HOME during migration.

Install keeps the cache (agent skills symlink into it; Aside ownership
markers point at it). Uninstall leaves the cache unless full
`uninstall --purge` (partial uninstall + purge would strand agent links).
EOF
}

# have CMD
# Exit 0 when CMD is on PATH.
# Side effects: none.
have() { command -v "$1" >/dev/null 2>&1; }

# die MSG…
# Prints an error to stderr and exits 1.
die() { echo "error: $*" >&2; exit 1; }

# Ownership signature — every shipped kit has had these. Pre-fetch guards
# (update, purge) use this set so a cache created before a skill was added is
# still recognized as kit-owned and can be upgraded or removed. A stray
# `skill/` alone is never enough. Single source of truth for the filesystem
# ownership probe.
KIT_OWNERSHIP_FILES="scripts/agents/install.sh scripts/agents/lib.sh
scripts/aside/install.sh scripts/aside/lib.sh
scripts/install.sh
scripts/uninstall.sh
skill/job-profile/SKILL.md
skill/job-scout/SKILL.md"

# Ownership signature for caches predating the unified uninstaller: the same
# set minus `scripts/uninstall.sh`, which those revisions never shipped. Only
# the migration refresh in `ensure_kit_cache` may use it, and only after a
# channel `uninstall.sh` has already proved the tree is an older job-kit.
KIT_LEGACY_OWNERSHIP_FILES="scripts/agents/install.sh scripts/agents/lib.sh
scripts/aside/install.sh scripts/aside/lib.sh
skill/job-profile-init/SKILL.md
skill/job-scout/SKILL.md"

# Ownership signature for caches shipped before the profile/captcha rename.
# ensure_kit_cache uses this to refresh trees that still have job-profile-init.
KIT_PREVIOUS_OWNERSHIP_FILES="scripts/agents/install.sh scripts/agents/lib.sh
scripts/aside/install.sh scripts/aside/lib.sh
scripts/install.sh
scripts/uninstall.sh
skill/job-profile-init/SKILL.md
skill/job-scout/SKILL.md"

# Full layout expected after fetch / before install: ownership files plus every
# skill this revision ships. Post-fetch validation uses this set so an invalid
# download cannot replace the cache with a tree missing a new skill.
# `require_skill_source` in scripts/{agents,aside}/lib.sh rejects a skill
# without SKILL.md, and by then the cache has already been replaced — so the
# payload is checked here, not only the installer scripts.
KIT_REQUIRED_FILES="${KIT_OWNERSHIP_FILES}
scripts/common.sh
scripts/browser-use/install.sh
skill/captcha-solver/SKILL.md
skill/job-apply/SKILL.md
skill/job-prep/SKILL.md
skill/job-resume-refine/SKILL.md
skill/job-list/SKILL.md
skill/job-match/SKILL.md
skill/job-match/scripts/score.py
skill/job-match/scripts/models.py
skill/job-match/scripts/scaffold_guidance.py
skill/job-match/scripts/validate_guidance.py
skill/job-match/scripts/typesafe_match.py
skill/job-match/scripts/years.py
skill/job-profile/scripts/geography.py
skill/job-profile/scripts/geography.json
skill/job-profile/references/contracts/contract-geography.md
skill/job-resume-refine/scripts/check_parse.py
skill/job-resume-refine/scripts/evaluate_pdf.py
skill/job-store/scripts/normalize_url.py
skill/job-store/scripts/validate_extract.py
skill/job-store/scripts/validate_dossier.py
skill/job-store/scripts/normalize_source.py
skill/job-humanize/scripts/detect.py
skill/job-stories/SKILL.md
skill/job-inbox/SKILL.md
skill/job-humanize/SKILL.md
skill/job-profile-root/SKILL.md
skill/job-store/SKILL.md
scripts/remote.sh
scripts/remote.ps1
LICENSE"

# kit_paths_missing DIR FILE_LIST
# Prints the first path from FILE_LIST missing from DIR (or present as a
# symlink); prints nothing when every path is a regular file under a real
# `skill/` directory. Rejects a symlink at any path component because Bash
# `test -f`/`-d` follow intermediate links, which would accept a tarball where
# e.g. `skill/job-scout` is mode-`120000` while the leaf `SKILL.md` is a
# regular file.
# Side effects: none.
kit_paths_missing() {
  local dir="$1" files="$2" rel cur part rest
  if [ -L "${dir}/skill" ] || [ ! -d "${dir}/skill" ]; then
    printf '%s\n' "skill/"
    return 0
  fi
  for rel in ${files}; do
    cur="${dir}"
    rest="${rel}"
    while [ -n "${rest}" ]; do
      case "${rest}" in
        */*)
          part="${rest%%/*}"
          rest="${rest#*/}"
          ;;
        *)
          part="${rest}"
          rest=""
          ;;
      esac
      [ -n "${part}" ] || continue
      cur="${cur}/${part}"
      if [ -L "${cur}" ]; then
        printf '%s\n' "${rel}"
        return 0
      fi
    done
    if [ ! -f "${dir}/${rel}" ]; then
      printf '%s\n' "${rel}"
      return 0
    fi
  done
}

# kit_owned_missing DIR — pre-fetch / purge ownership (legacy caches pass).
kit_owned_missing() { kit_paths_missing "$1" "${KIT_OWNERSHIP_FILES}"; }

# kit_checkout_missing DIR — full post-fetch / pre-install layout.
kit_checkout_missing() { kit_paths_missing "$1" "${KIT_REQUIRED_FILES}"; }

# resolve_cache_path PATH
# Prints PATH after stripping trailing slashes. When PATH is an existing
# symlink, prints the physical directory it resolves to (`pwd -P`), so a
# bundle refresh updates the real cache that agent installers record via
# `pwd -P` rather than deleting the link and orphaning that target.
# Side effects: none. Dies on a dangling symlink.
resolve_cache_path() {
  local p
  p="$(strip_trailing_slashes "$1")"
  if [ -L "${p}" ]; then
    [ -d "${p}" ] || die "cache path is a dangling symlink: ${p}"
    (cd "${p}" && pwd -P) || die "failed to resolve cache symlink: ${p}"
    return 0
  fi
  printf '%s' "${p}"
}

# release_version_file FILE
# Prints one strict vX.Y.Z version. The file must contain exactly that line.
release_version_file() {
  local file="$1" version
  [ -f "${file}" ] && [ ! -L "${file}" ] || return 1
  version="$(cat "${file}")" || return 1
  [[ "${version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s\n' "${version}" | cmp -s - "${file}" || return 1
  printf '%s\n' "${version}"
}

# download_release_file URL DEST
# Downloads to a staging file. Never executes the response.
download_release_file() {
  local url="$1" dest="$2"
  if have curl; then
    curl -fsSL "${url}" > "${dest}"
  else
    wget -qO- "${url}" > "${dest}"
  fi
}

# release_archive_safe ARCHIVE STAGE
# Releases contain only regular files/directories below job-kit/. Check names
# and entry types before extraction so traversal or links cannot escape STAGE.
release_archive_safe() {
  local archive="$1" stage="$2" entry
  tar -tzf "${archive}" > "${stage}/entries" || return 1
  [ -s "${stage}/entries" ] || return 1
  LC_ALL=C awk '/[[:cntrl:]]/ { exit 1 }' "${stage}/entries" || return 1
  while IFS= read -r entry; do
    case "${entry}" in
      job-kit/.git|job-kit/.git/*) return 1 ;;
      job-kit|job-kit/|job-kit/*) ;;
      *) return 1 ;;
    esac
    case "/${entry}/" in
      */../*|*/./*|*\\*) return 1 ;;
    esac
  done < "${stage}/entries"
  tar -tvzf "${archive}" > "${stage}/entry-types" || return 1
  LC_ALL=C awk '
    substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }
    END { if (NR == 0) exit 1 }
  ' "${stage}/entry-types"
}

# fetch_kit DEST [OWNERSHIP_FILES]
# Downloads a release, verifies its checksum/version/layout, then swaps it into
# the same physical path. Legacy caches keep a sibling backup; bundle updates
# remove their temporary backup after success. All staging is cleaned on exit.
fetch_kit() (
  local dest files missing parent stage version asset base archive expected actual
  local payload backup="" retain_backup=1
  [ -z "${JOB_KIT_REF:-}" ] \
    || die "JOB_KIT_REF is no longer supported; use JOB_KIT_VERSION=vX.Y.Z for a published release, or scripts/install.sh from a local source checkout"
  version="${JOB_KIT_VERSION}"
  if [ "${version}" != latest ]; then
    [[ "${version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || die "JOB_KIT_VERSION must be latest or a release tag vX.Y.Z (got: ${version})"
  fi
  dest="$(resolve_cache_path "$1")"
  files="${2:-${KIT_OWNERSHIP_FILES}}"
  if [ -L "${dest}" ] || [ -e "${dest}" ]; then
    missing="$(kit_paths_missing "${dest}" "${files}")"
    [ -z "${missing}" ] \
      || die "cache path exists and is not a job-kit installation (missing ${missing}): ${dest}"
    if [ -L "${dest}/.git" ] || { [ -e "${dest}/.git" ] && [ ! -d "${dest}/.git" ]; }; then
      die "cannot migrate a cache with a .git file or symlink: ${dest}; use a separate JOB_KIT_HOME or install from the local checkout"
    fi
    # Only a prior complete release bundle can be discarded after an update.
    # A source checkout, including one with local edits, keeps its full backup.
    if [ ! -e "${dest}/.git" ] \
      && release_version_file "${dest}/VERSION" >/dev/null \
      && [ -z "$(kit_checkout_missing "${dest}")" ]; then
      retain_backup=0
    fi
  fi
  have tar || die "need tar to install a job-kit release"
  { have curl || have wget; } || die "need curl or wget to download a job-kit release"
  { have sha256sum || have shasum; } || die "need sha256sum or shasum to verify a job-kit release"
  parent="$(dirname "${dest}")"
  mkdir -p "${parent}" || die "failed to create: ${parent}"
  stage="$(mktemp -d "${parent}/.job-kit-fetch.XXXXXX")" \
    || die "failed to create release staging directory under ${parent}"
  trap 'rm -rf "${stage}"' EXIT
  if [ "${version}" = latest ]; then
    download_release_file "https://github.com/${JOB_KIT_SLUG}/releases/latest/download/VERSION" "${stage}/VERSION" \
      || die "failed to resolve the latest job-kit release; cache left unchanged"
    version="$(release_version_file "${stage}/VERSION")" \
      || die "latest release VERSION must contain one vX.Y.Z line; cache left unchanged"
  fi
  asset="job-kit-${version}.tar.gz"
  base="https://github.com/${JOB_KIT_SLUG}/releases/download/${version}"
  archive="${stage}/${asset}"
  download_release_file "${base}/${asset}" "${archive}" \
    || die "download failed: ${base}/${asset}; cache left unchanged"
  download_release_file "${base}/SHA256SUMS" "${stage}/SHA256SUMS" \
    || die "download failed: ${base}/SHA256SUMS; cache left unchanged"
  expected="$(awk -v asset="${asset}" '
    NF == 2 && $2 == asset { count++; hash = $1 }
    END { if (count != 1) exit 1; print hash }
  ' "${stage}/SHA256SUMS")" \
    || die "SHA256SUMS must contain exactly one checksum for ${asset}; cache left unchanged"
  case "${expected}" in
    ""|*[!0-9a-fA-F]*) die "invalid SHA256 checksum for ${asset}; cache left unchanged" ;;
  esac
  [ "${#expected}" -eq 64 ] || die "invalid SHA256 checksum for ${asset}; cache left unchanged"
  if have sha256sum; then
    actual="$(sha256sum "${archive}")" || die "failed to hash ${asset}; cache left unchanged"
  else
    actual="$(shasum -a 256 "${archive}")" || die "failed to hash ${asset}; cache left unchanged"
  fi
  actual="${actual%% *}"
  expected="$(printf '%s' "${expected}" | tr 'A-F' 'a-f')"
  [ "${actual}" = "${expected}" ] || die "checksum mismatch for ${asset}; cache left unchanged"
  release_archive_safe "${archive}" "${stage}" \
    || die "release archive contains invalid paths or non-regular entries; cache left unchanged"
  mkdir "${stage}/unpack" || die "failed to prepare release extraction"
  tar -xzf "${archive}" -C "${stage}/unpack" || die "failed to extract ${asset}; cache left unchanged"
  payload="${stage}/unpack/job-kit"
  missing="$(kit_checkout_missing "${payload}")"
  [ -z "${missing}" ] \
    || die "downloaded ${JOB_KIT_SLUG}@${version} is not a job-kit bundle (missing ${missing}); cache left unchanged"
  [ "$(release_version_file "${payload}/VERSION")" = "${version}" ] \
    || die "bundle VERSION does not match ${version}; cache left unchanged"
  if [ -e "${dest}" ]; then
    backup="$(mktemp -d "${dest}.backup-XXXXXX")" || die "failed to create cache backup"
    rmdir "${backup}" || die "failed to prepare cache backup: ${backup}"
    mv "${dest}" "${backup}" || die "failed to back up cache: ${dest}; cache left unchanged"
  fi
  if ! mv "${payload}" "${dest}"; then
    if [ -n "${backup}" ]; then
      mv "${backup}" "${dest}" \
        || die "failed to install bundle and restore cache; previous installation remains at ${backup}"
      die "failed to install bundle at ${dest}; previous cache restored"
    fi
    die "failed to install bundle at ${dest}"
  fi
  if [ -n "${backup}" ]; then
    if [ "${retain_backup}" -eq 1 ]; then
      echo "legacy installation backed up at: ${backup}"
    else
      rm -rf "${backup}" || die "bundle installed, but failed to remove previous bundle backup: ${backup}"
    fi
  fi
  echo "installed bundle: ${dest} @ ${version}"
)

# require_checkout DIR
# Fails unless DIR has the full layout the channel installers expect for this
# revision (KIT_REQUIRED_FILES). Use after fetch, not as a pre-fetch ownership
# gate — legacy caches may lack skills added later.
# Side effects: none.
require_checkout() {
  local dir="$1" missing
  missing="$(kit_checkout_missing "${dir}")"
  [ -z "${missing}" ] || die "not a job-kit bundle (missing ${missing}): ${dir}"
}

# ensure_kit_cache DEST
# Ensures DEST is kit-owned and usable for uninstall (or freshly fetched).
# Absent → fetch_kit + full require_checkout. Present → ownership signature
# (legacy caches without newer skills still pass; do not force a refresh —
# agent symlink ownership strings match install's pwd -P path), then a
# feature-detect that the cached uninstaller accepts `browser-use` so a
# pre-this-channel cache is refreshed before that target is forwarded.
# Side effects: may create DEST via fetch_kit.
ensure_kit_cache() {
  local dest raw missing
  raw="$(strip_trailing_slashes "$1")"
  if [ ! -L "${raw}" ] && [ ! -e "${raw}" ]; then
    fetch_kit "${raw}"
    require_checkout "${raw}"
    return 0
  fi
  dest="$(resolve_cache_path "${raw}")"
  missing="$(kit_owned_missing "${dest}")"
  if [ -n "${missing}" ]; then
    # Caches from before the profile/captcha skill rename still have
    # skill/job-profile-init/SKILL.md as the ownership probe.
    if [ -z "$(kit_paths_missing "${dest}" "${KIT_PREVIOUS_OWNERSHIP_FILES}")" ]; then
      echo "refreshing kit cache (skill names changed): ${dest}"
      fetch_kit "${raw}" "${KIT_PREVIOUS_OWNERSHIP_FILES}"
      require_checkout "${raw}"
      return 0
    fi
    # Pre-single-uninstall caches still have channel uninstall.sh; refresh once,
    # probing with the legacy signature so the refresh is not rejected for the
    # very file it exists to install.
    if [ -z "$(kit_paths_missing "${dest}" "${KIT_LEGACY_OWNERSHIP_FILES}")" ] \
      && { [ -f "${dest}/scripts/aside/uninstall.sh" ] || [ -f "${dest}/scripts/agents/uninstall.sh" ]; }; then
      echo "refreshing kit cache (uninstall layout changed): ${dest}"
      fetch_kit "${raw}" "${KIT_LEGACY_OWNERSHIP_FILES}"
      require_checkout "${raw}"
      return 0
    fi
    # Caches from after unified uninstall but before unified install lack
    # scripts/install.sh. Prove with the ownership set minus that file.
    if [ ! -f "${dest}/scripts/install.sh" ] \
      && [ -z "$(kit_paths_missing "${dest}" "${KIT_LEGACY_OWNERSHIP_FILES}
scripts/uninstall.sh")" ]; then
      echo "refreshing kit cache (install layout changed): ${dest}"
      fetch_kit "${raw}" "${KIT_LEGACY_OWNERSHIP_FILES}
scripts/uninstall.sh"
      require_checkout "${raw}"
      return 0
    fi
    die "cache path exists and is not a job-kit installation (missing ${missing}): ${dest}"
  fi
  # Unified-layout caches from before this channel accept the ownership
  # signature but die on the new `browser-use` positional target. Detect that
  # token in the cached uninstaller so remote uninstall and `--purge` refresh
  # once instead of exiting before anything is removed.
  if ! grep -Fq 'aside|agents|browser-use|profile|cache|all' \
    "${dest}/scripts/uninstall.sh"; then
    echo "refreshing kit cache (uninstall target added): ${dest}"
    fetch_kit "${raw}"
    require_checkout "${raw}"
    return 0
  fi
}

# main
# Parses install channel or `uninstall [target]`, ensures cache, delegates.
# Side effects: may write/remove cache; runs install or uninstall scripts.
main() {
  local channel="all" mode="install" target="all" arg purge=0

  if [ "$#" -gt 0 ]; then
    case "$1" in
      uninstall)
        mode="uninstall"
        shift
        case "${1:-}" in
          all|aside|agents|browser-use) target="$1"; shift ;;
        esac
        ;;
      all|aside|agents|browser-use|fetch) channel="$1"; shift ;;
      -h|--help) usage; exit 0 ;;
    esac
  fi

  if [ "${mode}" = "uninstall" ]; then
    purge=0
    # Every target accepts the same two options; --purge is validated below.
    for arg in "$@"; do
      case "${arg}" in
        --purge) purge=1; continue ;;
        -h|--help) usage; exit 0 ;;
      esac
      die "uninstall ${target} accepts only --purge (got: ${arg})"
    done

    # Validate the purge before anything is uninstalled: a refused option
    # combination must leave the machine untouched, not half torn down.
    if [ "${purge}" -eq 1 ]; then
      # The cache is an irreversible row, so uninstall.sh gates it behind a
      # typed "yes" read from stdin. Piped in (curl … | bash), stdin is the
      # script itself and that read hits EOF, aborting the whole run after the
      # plan is printed — nothing removed, no hint shown. Refuse up front and
      # name the local command, which prompts on a terminal.
      [ -t 0 ] \
        || die "refusing --purge over a pipe (removing the cache needs a typed 'yes'; run: bash ${JOB_KIT_HOME}/scripts/remote.sh uninstall --purge)"
      # Agent skills symlink into JOB_KIT_HOME. Partial uninstall leaves some
      # of those links (or the whole agents channel) still pointing at the
      # cache — refuse to delete it until both channels are torn down.
      [ "${target}" = "all" ] \
        || die "refusing --purge with partial uninstall (use 'uninstall all --purge' or omit --purge)"
      # A skills-root override narrows its channel to that one destination, so
      # the default homes keep kit-owned links/copies that the purge would
      # strand. Unset it and rerun to uninstall the default homes too.
      [ -z "${CLAUDE_SKILLS:-}" ] \
        || die "refusing --purge while CLAUDE_SKILLS narrows the agents uninstall to ${CLAUDE_SKILLS} (unset it, or omit --purge)"
      [ -z "${ASIDE_SKILLS:-}" ] \
        || die "refusing --purge while ASIDE_SKILLS narrows the Aside uninstall to ${ASIDE_SKILLS} (unset it, or omit --purge)"
    fi

    # Ownership only — uninstall scripts live in the ownership set; do not
    # require skills added after the cache was created (would block uninstall).
    ensure_kit_cache "${JOB_KIT_HOME}"

    case "${target}" in
      aside)
        bash "${JOB_KIT_HOME}/scripts/uninstall.sh" aside
        ;;
      agents)
        bash "${JOB_KIT_HOME}/scripts/uninstall.sh" agents
        ;;
      browser-use)
        bash "${JOB_KIT_HOME}/scripts/uninstall.sh" browser-use
        ;;
      all)
        # Skills only over curl — never deletes profile data (~/.config/job-kit).
        # With --purge, `cache` joins the same invocation so the composite
        # preflight runs before anything is unlinked: a survivor found after the
        # unlink pass would otherwise leave a failed, half-finished uninstall.
        if [ "${purge}" -eq 1 ]; then
          bash "${JOB_KIT_HOME}/scripts/uninstall.sh" aside agents browser-use cache
        else
          bash "${JOB_KIT_HOME}/scripts/uninstall.sh" aside agents browser-use
        fi
        ;;
    esac

    echo
    if [ "${purge}" -eq 1 ]; then
      echo "job-kit uninstall finished (cache purged)"
    else
      echo "job-kit uninstall finished"
      echo "  cache kept at: ${JOB_KIT_HOME}"
      echo "  reinstall: curl -fsSL https://raw.githubusercontent.com/${JOB_KIT_SLUG}/main/scripts/remote.sh | bash -s -- all"
      echo "  purge cache: bash ${JOB_KIT_HOME}/scripts/remote.sh uninstall --purge"
      echo "           or: rm -rf ${JOB_KIT_HOME}"
    fi
    return 0
  fi

  fetch_kit "${JOB_KIT_HOME}"
  require_checkout "${JOB_KIT_HOME}"

  case "${channel}" in
    fetch) ;;
    aside)
      bash "${JOB_KIT_HOME}/scripts/aside/install.sh" "$@"
      ;;
    agents)
      bash "${JOB_KIT_HOME}/scripts/agents/install.sh" "$@"
      ;;
    browser-use)
      bash "${JOB_KIT_HOME}/scripts/browser-use/install.sh" "$@"
      ;;
    all)
      # install.sh owns what `all` means: the readiness gates that skip an
      # absent channel, and the `nothing installed` failure when none is there.
      bash "${JOB_KIT_HOME}/scripts/install.sh" all "$@"
      ;;
  esac

  echo
  echo "job-kit cached at: ${JOB_KIT_HOME}"
  echo "  keep it: agent skills symlink into it, Aside re-runs prove ownership by it"
  echo "  uninstall (interactive / profile): bash ${JOB_KIT_HOME}/scripts/uninstall.sh"
  echo "  uninstall (skills only): curl -fsSL https://raw.githubusercontent.com/${JOB_KIT_SLUG}/main/scripts/remote.sh | bash -s -- uninstall"
}

main "$@"
