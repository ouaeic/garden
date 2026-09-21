#!/bin/sh
# Sourced, never executed. What this host is, and what the things athanor needs are called on it.
# The variables set below are read by whoever sourced this, which is why shellcheck cannot see them.
# shellcheck disable=SC2034
#
# Every distribution-dependent fact lives here, in one place, for one reason: the same package
# names were already written down three times - in the installer, in the runner's toolchain probe,
# and in `athanor doctor` - and three copies of a list is three chances for one of them to be
# right. Widening past Debian would have made it twelve.
#
# The shape is a table and a handful of probes rather than a branch at every site. The install is
# about forty logical steps and only a handful of them actually differ; the rest - the three
# accounts, the setgid workspace scheme, the sudoers policy, the pinned downloads, the identity key,
# the readiness gates - is already host-neutral and correct, and forking nine hundred lines of
# security-relevant logic four ways to reach the fourteen that differ would be the wrong trade.

# --- what this host is -------------------------------------------------------------------------

# ID_LIKE is read as well as ID, so a derivative is recognised as what it is built from. Without it
# Mint, Pop!_OS, Raspbian and Devuan were refused as unknown while being ordinary apt hosts, and
# every RHEL rebuild would have needed its own name.

# The package manager on its own, without asking what distribution this is.
#
# It is probed rather than inferred, because that is the fact that actually matters and a
# derivative can surprise the name table. It is separable from the rest of `athanor_detect_host`
# because one caller needs only this: `athanor-system-packages` runs as root to install a package
# and has no use for the family, the version or the architecture. Refusing to install because
# /etc/os-release is absent - which is an ordinary container - would be an outage with a
# distribution-shaped message on it.
athanor_detect_package_manager() {
  athanor_pm=""
  for manager in apt-get dnf5 dnf zypper pacman; do
    if command -v "$manager" >/dev/null 2>&1; then
      athanor_pm="$manager"
      break
    fi
  done
  [ -n "$athanor_pm" ] || {
    printf 'athanor: no supported package manager found (looked for apt-get, dnf, zypper, pacman)\n' >&2
    return 1
  }
  return 0
}

athanor_detect_host() {
  [ -f /etc/os-release ] || {
    printf 'athanor: /etc/os-release is missing, so this host cannot be identified\n' >&2
    return 1
  }
  athanor_os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n1)
  athanor_os_like=$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | head -n1)
  athanor_os_version=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -n1)

  athanor_family=""
  for candidate in $athanor_os_id $athanor_os_like; do
    case "$candidate" in
    ubuntu | debian) athanor_family="debian" ;;
    fedora | rhel | centos | rocky | almalinux) athanor_family="rhel" ;;
    arch | archarm) athanor_family="arch" ;;
    suse | opensuse | opensuse-leap | opensuse-tumbleweed) athanor_family="suse" ;;
    esac
    [ -n "$athanor_family" ] && break
  done

  athanor_detect_package_manager || return 1
  [ -n "$athanor_family" ] || case "$athanor_pm" in
  apt-get) athanor_family="debian" ;;
  dnf | dnf5) athanor_family="rhel" ;;
  zypper) athanor_family="suse" ;;
  pacman) athanor_family="arch" ;;
  esac

  [ -n "$athanor_family" ] || {
    printf 'athanor: %s is not a distribution athanor knows, and its ID_LIKE names none it does\n' "$athanor_os_id" >&2
    return 1
  }

  # dpkg is Debian's, and reading the architecture from it aborted the installer on every other
  # host before it had said anything useful. uname is everywhere.
  case "$(uname -m)" in
  x86_64 | amd64) athanor_arch="amd64" ;;
  aarch64 | arm64) athanor_arch="arm64" ;;
  *)
    printf 'athanor: supported architectures are amd64 and arm64; this host is %s\n' "$(uname -m)" >&2
    return 1
    ;;
  esac
  return 0
}

# --- what the things athanor needs are called here ----------------------------------------------

# One row per capability, one column per family. A dash means the family has no such package and
# the capability is reached another way - the row's absence is the instruction to probe for it
# rather than to install it.
#
# Written as a here-document rather than a file so a sourced installer carries its own table, and
# read with awk so the three consumers read it identically.
#
# EVERY NAME HERE EITHER RESOLVES IN THAT FAMILY'S OWN INDEX OR SAYS IN THIS COMMENT WHAT IT WAS
# REASONED FROM, because `athanor_pm_install` hands the whole family list to the package manager in
# one command and the installer runs under `set -eu`. A name that does not resolve therefore does
# not degrade one capability quietly - it aborts the entire install. Where a family has no package
# at all the cell is a dash, which is a supported outcome: `athanor_missing_for_family` reports it
# and the installer warns once, by name, before anything is installed.
#
# python-pyarrow is here to close a claim rather than to widen the bench. The data-analysis skill's
# description triggers on "parquet file", and without pyarrow `pandas.read_parquet` answers "A
# suitable version of pyarrow or fastparquet is required for parquet support" - measured on the
# owner's own box, Ubuntu 26.04, with pandas installed and pyarrow absent. fastparquet is not an
# alternative route there: that release packages no python3-fastparquet at all.
#
# It is not a cheap row: 21 packages and 88,059 KB installed on that host, Qt5 among them, arriving
# behind libgandiva. Those two figures come from `apt-get install -s` on that one box and not from a
# real install, and they are not a ranking - the other 59 rows were not measured, so whether this is
# the second-heaviest row here is not something this comment knows. It is paid because a skill
# naming a format the computer cannot read is worse than one that never mentions it.
#
# The suse cell is the reasoned kind rather than the measured kind, and this is the row where that
# is written down. openSUSE packages pyarrow per interpreter flavour - python313-pyarrow,
# python314-pyarrow - which is the same scheme it uses for the pandas, scipy, matplotlib and
# statsmodels rows below, and `python3-` is the spelling those four already carry in that column. So
# a `python3-pyarrow` that does not resolve would mean the pattern is broken for all five, and
# openSUSE installs would already be failing on the four that shipped before this one.
athanor_package_table() {
  # DNF resolves file provides, so X11 utilities work with both split and grouped RPM packages.
  cat <<'TABLE'
capability	debian	rhel	arch	suse
bubblewrap	bubblewrap	bubblewrap	bubblewrap	bubblewrap
accessibility	at-spi2-core	at-spi2-core	at-spi2-core	at-spi2-core
avahi	avahi-daemon	avahi	avahi	avahi
certificates	ca-certificates	ca-certificates	ca-certificates	ca-certificates
curl	curl	curl	curl	curl
dbus-session	dbus-x11	dbus-daemon	dbus	dbus-1-x11
ffmpeg	ffmpeg	ffmpeg-free	ffmpeg	ffmpeg
file	file	file	file	file
fontconfig	fontconfig	fontconfig	fontconfig	fontconfig
font-caladea	fonts-crosextra-caladea	caladea-fonts	-	-
font-carlito	fonts-crosextra-carlito	google-carlito-fonts	ttf-carlito	-
font-dejavu	fonts-dejavu-core	dejavu-sans-fonts	ttf-dejavu	dejavu-fonts
font-liberation	fonts-liberation	liberation-fonts	ttf-liberation	liberation-fonts
font-noto	fonts-noto-core	google-noto-sans-fonts	noto-fonts	noto-sans-fonts
ghostscript	ghostscript	ghostscript	ghostscript	ghostscript
git	git	git	git	git
graphviz	graphviz	graphviz	graphviz	graphviz
imagemagick	imagemagick	ImageMagick	imagemagick	ImageMagick
img2pdf	img2pdf	img2pdf	img2pdf	-
iproute	iproute2	iproute	iproute2	iproute2
jq	jq	jq	jq	jq
office-calc	libreoffice-calc	libreoffice-calc	libreoffice-still	libreoffice-calc
office-gtk	libreoffice-gtk3	libreoffice-gtk3	libreoffice-still	libreoffice-gtk3
office-impress	libreoffice-impress	libreoffice-impress	libreoffice-still	libreoffice-impress
office-writer	libreoffice-writer	libreoffice-writer	libreoffice-still	libreoffice-writer
nginx	nginx	nginx	nginx	nginx
ocrmypdf	ocrmypdf	-	-	-
selinux-tools	-	policycoreutils-python-utils	-	policycoreutils-python-utils
window-manager	openbox	-	openbox	openbox
openssl	openssl	openssl	openssl	openssl
poppler	poppler-utils	poppler-utils	poppler	poppler-tools
postgres-server	postgresql	postgresql-server	postgresql	postgresql-server
postgres-contrib	postgresql-contrib	postgresql-contrib	-	postgresql-contrib
python	python3	python3	python	python3
python-docx	python3-docx	python3-docx	-	-
python-gobject	python3-gi	python3-gobject	python-gobject	python3-gobject
python-lxml	python3-lxml	python3-lxml	python-lxml	python3-lxml
python-matplotlib	python3-matplotlib	python3-matplotlib	python-matplotlib	python3-matplotlib
python-openpyxl	python3-openpyxl	python3-openpyxl	python-openpyxl	python3-openpyxl
python-pandas	python3-pandas	python3-pandas	python-pandas	python3-pandas
python-pyarrow	python3-pyarrow	python3-pyarrow	python-pyarrow	python3-pyarrow
python-scipy	python3-scipy	python3-scipy	python-scipy	python3-scipy
python-statsmodels	python3-statsmodels	python3-statsmodels	python-statsmodels	python3-statsmodels
python-pillow	python3-pil	python3-pillow	python-pillow	python3-Pillow
python-atspi	python3-pyatspi	python3-pyatspi	python-atspi	python3-atspi
python-pip	python3-venv	python3-pip	python-pip	python3-pip
python-xlsxwriter	python3-xlsxwriter	python3-xlsxwriter	python-xlsxwriter	python3-XlsxWriter
qpdf	qpdf	qpdf	qpdf	qpdf
qrencode	qrencode	qrencode	qrencode	qrencode
ripgrep	ripgrep	ripgrep	ripgrep	ripgrep
sudo	sudo	sudo	sudo	sudo
tar	tar	tar	tar	tar
tesseract	tesseract-ocr	tesseract	tesseract	tesseract-ocr
tesseract-english	tesseract-ocr-eng	tesseract-langpack-eng	tesseract-data-eng	tesseract-ocr-traineddata-english
unzip	unzip	unzip	unzip	unzip
util-linux	util-linux	util-linux	util-linux	util-linux
wmctrl	wmctrl	wmctrl	wmctrl	wmctrl
xvfb	xvfb	xorg-x11-server-Xvfb	xorg-server-xvfb	xorg-x11-server
xrandr	x11-xserver-utils	/usr/bin/xrandr	xorg-xrandr	xrandr
xdpyinfo	x11-utils	/usr/bin/xdpyinfo	xorg-xdpyinfo	xdpyinfo
xprop	x11-utils	/usr/bin/xprop	xorg-xprop	xprop
xauth	xauth	/usr/bin/xauth	xorg-xauth	xauth
xdotool	xdotool	xdotool	xdotool	xdotool
zip	zip	zip	zip	zip
TABLE
}

# The package name for one capability on this host, or empty when the family has none.
athanor_package_for() {
  athanor_package_table | awk -F'\t' -v want="$1" -v family="$2" '
    NR == 1 { for (i = 2; i <= NF; i++) if ($i == family) column = i; next }
    $1 == want && column { if ($column != "-") print $column; exit }
  '
}

# Every package this family has, in table order, ready to hand to its package manager. Arch names
# the same LibreOffice package for four capabilities because it does not split them; the package
# managers all take a repeated name without complaint, and saying it four times keeps the table
# readable as a statement about capabilities rather than about packaging.
athanor_packages_for_family() {
  athanor_package_table | awk -F'\t' -v family="$1" '
    NR == 1 { for (i = 2; i <= NF; i++) if ($i == family) column = i; next }
    column && $column != "-" { print $column }
  '
}

# Capabilities this family has no package for, so the caller can say what will be missing rather
# than discovering it at the first document job.
athanor_missing_for_family() {
  athanor_package_table | awk -F'\t' -v family="$1" '
    NR == 1 { for (i = 2; i <= NF; i++) if ($i == family) column = i; next }
    column && $column == "-" { print $1 }
  '
}

# --- the five things that are not a package name ------------------------------------------------

athanor_pm_refresh() {
  case "$1" in
  apt-get) DEBIAN_FRONTEND=noninteractive apt-get update ;;
  dnf | dnf5) "$1" -y makecache ;;
  zypper) zypper --non-interactive refresh ;;
  pacman) pacman -Sy --noconfirm ;;
  esac
}

athanor_pm_install() {
  manager="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  case "$manager" in
  apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
  dnf | dnf5) "$manager" install -y --setopt=install_weak_deps=False "$@" ;;
  zypper) zypper --non-interactive install --no-recommends "$@" ;;
  pacman) pacman -S --noconfirm --needed "$@" ;;
  esac
}

# PostgreSQL is a metapackage that initialises itself on Debian and a bare server everywhere else.
# Skipping this left a database that would not start and an install that reported success.
athanor_postgres_prepare() {
  case "$1" in
  debian) return 0 ;;
  rhel)
    [ -s /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb
    ;;
  arch | suse)
    if [ ! -s /var/lib/postgres/data/PG_VERSION ] && [ ! -s /var/lib/pgsql/data/PG_VERSION ]; then
      su - postgres -c "initdb --locale=C.UTF-8 -D /var/lib/postgres/data" 2>/dev/null ||
        su - postgres -c "initdb --locale=C.UTF-8 -D /var/lib/pgsql/data"
    fi
    ;;
  esac
}

# Debian keeps site configuration in sites-enabled and includes it; everyone else uses conf.d.
# Writing to a directory that does not exist is how an install completes and then serves nothing.
athanor_nginx_site_path() {
  if [ -d /etc/nginx/sites-enabled ]; then
    printf '/etc/nginx/sites-enabled/athanor\n'
  else
    printf '/etc/nginx/conf.d/athanor.conf\n'
  fi
}
