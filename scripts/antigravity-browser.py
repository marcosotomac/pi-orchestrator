#!/usr/bin/env python3
"""Explicit OAuth browser hook. Never logs the authorization URL or its state."""
import subprocess
import sys
from urllib.parse import urlsplit


def valid_google_authorization(value):
    try:
        url = urlsplit(value)
        return (len(value) <= 16384 and not any(c.isspace() for c in value)
                and url.scheme == 'https' and url.hostname == 'accounts.google.com'
                and url.port in [None, 443] and not url.username and not url.password
                and url.path.startswith('/o/oauth2/'))
    except ValueError:
        return False


if __name__ == '__main__':
    if len(sys.argv) != 2 or not valid_google_authorization(sys.argv[1]):
        sys.exit(1)
    result = subprocess.run(['/usr/bin/open', sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode == 0:
        print('Antigravity Google sign-in opened in your browser.', file=sys.stderr)
    sys.exit(result.returncode)
