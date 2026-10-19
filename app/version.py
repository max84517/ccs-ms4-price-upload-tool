"""Contract version shared by the backend and the browser.

The static files are read from disk on every request, so a browser can end up
running new JavaScript against a server process that was started before the
code changed. Bumping this whenever the API changes lets the page say so
instead of failing with a confusing error.
"""

API_VERSION = "6"
