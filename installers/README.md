# One-line installers for self-run nginx and Apache

These are the exact scripts `https://aipaygen.com/install/nginx` and `https://aipaygen.com/install/apache` serve. They're kept here so you can compare before running a script as root: the file you download from aipaygen.com should have the same SHA-256 as the one here (`SHA256SUMS`).

    curl -fsSLo aipaygen-install.sh https://aipaygen.com/install/nginx
    sha256sum aipaygen-install.sh        # compare with SHA256SUMS in this folder
    less aipaygen-install.sh
    sudo sh aipaygen-install.sh --route YOUR_ROUTE_ID

What each script does is in its own header. In short: it sets up the free AI crawler report on a Debian/Ubuntu layout, asks for your gateway secret without showing it (or reads it from a root-only file with `--secret-file`), stores it in `/etc/aipaygen/secret` (mode 600), adds one marked include line to your site's block only when there's exactly one block for your site, checks the configuration and undoes everything if that fails, then adds a cron job. `--uninstall` removes exactly what it added; `--dry-run` shows the plan and changes nothing.

They're generated from the AIPayGen gateway's source; don't edit them here.
