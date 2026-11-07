# get_urls API Documentation

## Overview

Batch endpoint to retrieve public R2 download URLs for multiple audiobooks in a single request.

---

## Endpoints

| Endpoint | Authentication | Description |
|----------|----------------|-------------|
| `POST /getUrls` | Bearer Token | Authenticated endpoint |
| `POST /getUrlsNoAuth` | None (uid in body) | No-auth endpoint (requires `isNoAuthAllowed` setting) |

**Base URL:** `https://europe-west2-<project-id>.cloudfunctions.net`

---

## Request

### Headers

#### For `getUrls` (authenticated)
```
Authorization: Bearer <firebase-id-token>
Content-Type: application/json
```

#### For `getUrlsNoAuth`
```
Content-Type: application/json
```

### Body

```json
{
  "books": [
    {
      "bookGuid": "string (required)",
      "quality": "number (required) - 64 | 128 | 256",
      "reason": "string (required) - 'download' | 'stream' | 'sample'"
    }
  ],
  "platform": "string (required) - 'ios' | 'android'",
  "deviceId": "string (optional)",
  "build_number": "string (optional) - client app build number"
}
```

#### For `getUrlsNoAuth` only - additional field:
```json
{
  "uid": "string (required) - Firebase user ID",
  "books": [...],
  "platform": "...",
  "deviceId": "..."
}
```

### Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `books` | Array | Yes | Array of book objects to fetch URLs for |
| `books[].bookGuid` | String | Yes | Unique identifier of the book |
| `books[].quality` | Number | Yes | Audio quality in kbps (64, 128, or 256) |
| `books[].reason` | String | Yes | Purpose of the request: `download`, `stream` or `sample`. It is validated but not recorded |
| `platform` | String | Yes | Target platform - determines file format |
| `deviceId` | String | No | Device identifier. Accepted for older apps; not stored |
| `build_number` | String | No | Client app build number. Decides whether the allowance policy applies (see Allowance policy) |
| `provider` | String | No | `bunny` (`https://good-storage.b-cdn.net`) or `cloudflare` (`https://books.good-storage.click`). Overrides the country rule so the app can switch CDN when one fails to play; absent keeps the country rule. Any other value fails with HTTP 400: `{"code": 400, "message": "Invalid 'provider'. Expected bunny or cloudflare."}`. Read by `getUrls` and the Worker only |
| `uid` | String | NoAuth only | Firebase user ID (only for `getUrlsNoAuth`) |

### Platform Effects

| Platform | File Extension |
|----------|---------------|
| `ios` | `.m4a` |
| `android` | `.opus` |

---

## Response

### Success Response (200 OK)

```json
{
  "code": 600,
  "message": "success",
  "data": {
    "<bookGuid>": {
      "recordings": [
        {
          "name": "Chapter 1",
          "duration": 1234,
          "ext": "opus",
          "url": "https://books.good-storage.click/path/to/file.opus"
        },
        {
          "name": "Chapter 2",
          "duration": 987,
          "ext": "opus",
          "url": "https://books.good-storage.click/path/to/file2.opus"
        }
      ],
      "expiresAt": "2026-04-13T12:00:00.000Z"
    },
    "<anotherBookGuid>": {
      "recordings": [...],
      "expiresAt": "2026-04-13T12:00:00.000Z"
    }
  }
}
```

### Response Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `code` | Number | Response code (600 = success) |
| `message` | String | Response message |
| `data` | Object | Map of bookGuid to book data |
| `data[bookGuid].recordings` | Array | List of recording URLs |
| `data[bookGuid].recordings[].name` | String | Recording/chapter name |
| `data[bookGuid].recordings[].duration` | Number | Duration in seconds |
| `data[bookGuid].recordings[].ext` | String | File extension |
| `data[bookGuid].recordings[].url` | String | Public R2 download URL |
| `data[bookGuid].expiresAt` | String | Expiry timestamp (ISO 8601, 1 month from request) |

---

## Error Responses

### Error Response Format

```json
{
  "code": <error_code>,
  "message": "<error_message>",
  "bookGuid": "<optional - which book caused the error>"
}
```

### Error Codes

| Code | HTTP Status | Message | Description |
|------|-------------|---------|-------------|
| 400 | 400 | Various | Invalid request body or missing fields |
| 401 | 401 | `unauthorized` | Invalid or missing Bearer token |
| 601 | 400 | `not-found-book` | Book with given GUID does not exist |
| 602 | 400 | `not-found-user` | User does not exist in Firebase Auth |
| 603 | 403 | `unauthorized` | NoAuth endpoint called when `isNoAuthAllowed` is false |
| 604 | 400 | `not-found-quality` | Requested quality not available for recording |
| 605 | 400 | `not-found-recordings` | No recordings found for the book |
| 608 | 400 | `email-not-verified` | User's email is not verified |

### Error Examples

#### Missing required field
```json
{
  "code": 400,
  "message": "Missing required field: platform"
}
```

#### Book not found
```json
{
  "code": 601,
  "message": "not-found-book",
  "bookGuid": "invalid-book-id"
}
```

#### Email not verified
```json
{
  "code": 608,
  "message": "email-not-verified"
}
```

#### Quality not available
```json
{
  "code": 604,
  "message": "not-found-quality"
}
```

---

## Examples

### Example 1: Single Book Request (Authenticated)

**Request:**
```bash
curl -X POST \
  'https://europe-west2-<project-id>.cloudfunctions.net/getUrls' \
  -H 'Authorization: Bearer <firebase-id-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "books": [
      {
        "bookGuid": "ko0vFWslSODtjG9W82CG",
        "quality": 64,
        "reason": "download"
      }
    ],
    "platform": "android",
    "deviceId": "device-001"
  }'
```

**Response:**
```json
{
  "code": 600,
  "message": "success",
  "data": {
    "ko0vFWslSODtjG9W82CG": {
      "recordings": [
        {
          "name": "Introduction",
          "duration": 300,
          "ext": "opus",
          "url": "https://books.good-storage.click/audio/ko0vFWslSODtjG9W82CG/64/intro.opus"
        },
        {
          "name": "Chapter 1",
          "duration": 1800,
          "ext": "opus",
          "url": "https://books.good-storage.click/audio/ko0vFWslSODtjG9W82CG/64/ch1.opus"
        }
      ],
      "expiresAt": "2026-04-13T10:30:00.000Z"
    }
  }
}
```

### Example 2: Multiple Books Request (Authenticated)

**Request:**
```bash
curl -X POST \
  'https://europe-west2-<project-id>.cloudfunctions.net/getUrls' \
  -H 'Authorization: Bearer <firebase-id-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "books": [
      {
        "bookGuid": "ko0vFWslSODtjG9W82CG",
        "quality": 64,
        "reason": "download"
      },
      {
        "bookGuid": "abc123XYZ789",
        "quality": 128,
        "reason": "stream"
      },
      {
        "bookGuid": "def456UVW321",
        "quality": 64,
        "reason": "sample"
      }
    ],
    "platform": "ios",
    "deviceId": "iPhone-12-Pro"
  }'
```

**Response:**
```json
{
  "code": 600,
  "message": "success",
  "data": {
    "ko0vFWslSODtjG9W82CG": {
      "recordings": [
        {
          "name": "Chapter 1",
          "duration": 1800,
          "ext": "m4a",
          "url": "https://books.good-storage.click/audio/ko0vFWslSODtjG9W82CG/64/ch1.m4a"
        }
      ],
      "expiresAt": "2026-04-13T10:30:00.000Z"
    },
    "abc123XYZ789": {
      "recordings": [
        {
          "name": "Part 1",
          "duration": 2400,
          "ext": "m4a",
          "url": "https://books.good-storage.click/audio/abc123XYZ789/128/part1.m4a"
        }
      ],
      "expiresAt": "2026-04-13T10:30:00.000Z"
    },
    "def456UVW321": {
      "recordings": [
        {
          "name": "Episode 1",
          "duration": 900,
          "ext": "m4a",
          "url": "https://books.good-storage.click/audio/def456UVW321/64/ep1.m4a"
        }
      ],
      "expiresAt": "2026-04-13T10:30:00.000Z"
    }
  }
}
```

### Example 3: No-Auth Endpoint

**Request:**
```bash
curl -X POST \
  'https://europe-west2-<project-id>.cloudfunctions.net/getUrlsNoAuth' \
  -H 'Content-Type: application/json' \
  -d '{
    "uid": "wqj1yEqF1rhHKo1BwfA9ShEUbgY2",
    "books": [
      {
        "bookGuid": "ko0vFWslSODtjG9W82CG",
        "quality": 64,
        "reason": "download"
      }
    ],
    "platform": "android"
  }'
```

---

## Allowance policy

The policy is switched on by the `urlPolicy` block of `settings/mantooqAppSettings`. Without that block, or for a build below its `minBuild`, the endpoint answers as described above. The request cap applies to every build.

### Request

| Field / header | Description |
|----------------|-------------|
| `build_number` | Now read. Compared with `minBuild` to decide whether the request is under the policy; a missing or non-numeric value counts as build 0 |
| `X-Firebase-AppCheck` (header, optional) | Firebase App Check token. A request with a valid token gets the larger allowance; without one it gets the smaller allowance |
| `provider` | Chooses the host as above; each link is signed in that host's format (Cloudflare `verify`, Bunny `token` and `expires`) |
| `books` | At most 40 books per request. A longer list fails with HTTP 400: `{"code": 400, "message": "At most 40 books per request."}` |

### Response under the policy

Granted books keep the shape above. A book the allowance refused is a refusal entry in `data` next to the granted ones:

```json
{
  "code": 600,
  "message": "success",
  "data": {
    "<grantedBookGuid>": {
      "recordings": [{ "name": "Chapter 1", "duration": 1234, "ext": "m4a", "url": "https://books.good-storage.click/path/to/file.m4a?u=...&k=...&verify=..." }],
      "expiresAt": "2026-11-12T12:00:00.000Z"
    },
    "<refusedBookGuid>": {
      "error": 609,
      "retryAfterSeconds": 3600,
      "allowance": 10,
      "used": 10,
      "kind": "books"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data[bookGuid].error` | Number | `609` when the book was refused |
| `data[bookGuid].retryAfterSeconds` | Number | Seconds until the allowance frees a slot (at least 60) |
| `data[bookGuid].allowance` | Number | New books (or samples) allowed per rolling 24 hours |
| `data[bookGuid].used` | Number | New books (or samples) issued in the last 24 hours |
| `data[bookGuid].kind` | String | `books` for streams and downloads, `samples` for samples |

A book already issued to the account in the window does not use the allowance again.

When the request holds a single book and it is refused, the response is HTTP 400 with the refusal at the top level, so clients that only handle errors still see one code:

```json
{
  "code": 609,
  "message": "allowance-exhausted",
  "bookGuid": "<bookGuid>",
  "retryAfterSeconds": 3600,
  "allowance": 10,
  "used": 10,
  "kind": "books"
}
```

| Code | HTTP Status | Message | Description |
|------|-------------|---------|-------------|
| 609 | 400 | `allowance-exhausted` | Single-book request refused by the allowance |

### Links under the policy

- **Expiry**: `expiresAt` is the real expiry of the links, 7 days after the request. After it the CDN refuses them; request new ones.
- **Signed query parameters**: on the Cloudflare host (`books.good-storage.click`) each URL carries `u`, `k` and `verify`; on the Bunny host (`good-storage.b-cdn.net`) it carries `token` and `expires`. Send the URL unchanged. The signature covers the path, so a URL cannot be rewritten to another quality or file; request the other quality instead.
- **Samples**: a `sample` request returns chapter 1 only.

---

## Notes

1. **URL Expiry**: The `expiresAt` field is informational only (1 month from request time). Since R2 URLs are public, they don't actually expire - this is for client-side cache management.

2. **Batch Processing**: All books are processed in parallel for optimal speed. If any book fails (not found, no recordings, etc.), the entire request fails.

3. **Nothing is recorded**: The endpoint only reads Firestore. Book popularity comes from listening time, as described in `docs/book-chart.md`.

4. **Email Verification**: Users must have a verified email to use this endpoint. Unverified users receive error code 608.
