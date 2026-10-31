# Audio URL country routing

Firebase `getUrls` uses the bundled full IPverse `geo-ip-blocks` dataset for IPv4
and IPv6. Egypt (EG), Algeria (DZ), and Lebanon (LB) get `https://good-storage.b-cdn.net`; every other or unknown
country gets `https://books.good-storage.click`. `getUrlsNoAuth` and `webDownloads`
retain their existing Bunny default. Cloudflare retains its own country detection.

IPverse's country codes come from network registrations, including suballocations
and reassignments. They are not measured physical locations and can disagree with
Cloudflare's geolocation. Source: https://github.com/ipverse/geo-ip-blocks
The data is CC0; the upstream license is included in `IPVERSE-LICENSE`.

## Bundled snapshot and updates

`country-ip.bin` is checked into Git and shipped with Firebase. It contains all
countries, indexed by address family and prefix length. Sorted fixed-width records
allow binary searches without expanding the full dataset into JavaScript objects.
More-specific prefixes take precedence. Equally specific conflicting country
registrations resolve to unknown. No lookup API, account, or license key is needed.

The source commit and source date are embedded in the file. Run:

```bash
npm run build
npm run check:country-db
```

To update, download and extract the archive of a specific `ipverse/geo-ip-blocks`
commit from GitHub, then run:

```bash
node scripts/build-country-database.cjs /path/to/extracted-repository COMMIT_SHA COMMIT_DATE_ISO
npm run build
npm run check:country-db
npm test
```

Commit the updated binary and deploy `functions:getUrls`. The predeploy hook checks
the database, including IPv4 and IPv6 probes for all three selected countries and other countries. IPverse
publishes daily; refresh periodically. The checker warns when the snapshot is over
14 days old. There is no scheduled updater and no per-request download.

## Client IP and failure behavior

For the direct `cloudfunctions.net` endpoint, use the first `X-Forwarded-For`
address as documented by Google:
https://cloud.google.com/functions/docs/reference/headers
Fall back to the socket only when the header is absent. Invalid, private,
reserved or missing addresses are unknown; never substitute a later proxy IP.
IPv4-mapped IPv6 addresses are normalized. This is CDN selection, not an
access-control boundary: forwarded headers can include client-supplied values.
Revisit extraction if adding a CDN or another proxy in front of Firebase.

The file is loaded lazily once per instance. Runtime database errors log once and
use the original domain. Tests cover real data, prefix boundaries and overlaps,
IPv4/IPv6, header parsing, fallback behavior, and final Opus/AAC URLs. They verify
our matching, not the physical accuracy of every upstream country registration.
