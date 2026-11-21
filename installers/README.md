# One-line installers for self-run nginx and Apache

These are the exact scripts `https://aipaygen.com/install/nginx` and `https://aipaygen.com/install/apache` serve. They're kept here so you can compare before running a script as root: the file you download from aipaygen.com should have the same SHA-256 as the one here (`SHA256SUMS`).

    curl -fsSLo aipaygen-install.sh https://aipaygen.com/install/nginx
    sha256sum aipaygen-install.sh        # compare with SHA256SUMS in this folder
    less aipaygen-install.sh
    sudo sh aipaygen-install.sh --route YOUR_ROUTE_ID

What each script does is in its own header. In short: it sets up the free AI crawler report on a Debian/Ubuntu layout, asks for your gateway secret without showing it (or reads it from a root-only file with `--secret-file`), stores it in `/etc/aipaygen/secret` (mode 600), adds one marked include line to your site's block only when there's exactly one block for your site, checks the configuration and undoes everything if that fails, then adds a cron job. `--uninstall` removes exactly what it added; `--dry-run` shows the plan and changes nothing.

They carry no AI crawler names: the report script they install fetches those daily from https://aipaygen.com/v1/gateway/bots (https only, at most 64 KB) and accepts only the exact lines it expects. It also refuses a list with a name that would match ordinary browsers (shorter than 4 characters, a browser token such as Mozilla or Safari, or found in a browser's user agent) or one under half the size of the list in place, and then keeps the last good list. So these files (and their SHA-256) change only when the installer itself changes.

They're generated from the AIPayGen gateway's source; don't edit them here.
