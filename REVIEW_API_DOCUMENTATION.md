# Review API Documentation

This document describes how to call the authenticated review functions: `review`, `like`, and `flag`.

## Base Information

- **Region**: `europe-west2`
- **Authentication**: Firebase Authentication (Bearer token required)
- **Content-Type**: `application/json`

## Authentication

All functions require Firebase Authentication. Include the Firebase ID token in the `Authorization` header:

```
Authorization: Bearer <firebase_id_token>
```

---

## 1. Review Function

**Endpoint**: `https://europe-west2-<project-id>.cloudfunctions.net/review`

**Method**: `POST`

**Description**: Create, update, or delete a review/comment for a book.

### Request Body

```json
{
  "method": "put" | "update" | "delete",
  "book_guid": "string",
  "comment": "string",
  "book_rate": number,
  "narrator_rate": number
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `method` | string | Yes | Action to perform: `"put"` (create), `"update"` (edit), or `"delete"` (soft delete) |
| `book_guid` | string | Yes | Unique identifier for the book |
| `comment` | string | Yes | Review comment text (can be empty string `""`, max 2000 characters) |
| `book_rate` | number | Yes | Rating for the book (0-5, where 0 means not rated) |
| `narrator_rate` | number | Yes | Rating for the narrator (0-5, where 0 means not rated) |

### Method Details

#### `put` - Create New Review
- Creates a new review/comment for the book
- If a soft-deleted review exists, it will be restored
- Sets `is_edited: true` only if restoring with different comment text

#### `update` - Update Existing Review
- Updates an existing review (comment text and/or ratings)
- Cannot update soft-deleted reviews (must restore first)
- Sets `is_edited: true` only if comment text changed

#### `delete` - Soft Delete Review
- Marks the review as deleted (`is_deleted: true`)
- Does not actually delete the document
- Removes ratings from book metadata

### Validation Rules

- `book_rate`: Must be between 0 and 5 (inclusive)
- `narrator_rate`: Must be between 0 and 5 (inclusive)
- `comment`: Must be a string with maximum 2000 characters (can be empty string)

### Success Response

```json
{
  "code": 200,
  "message": "Comment added successfully." | "Comment updated successfully." | "Comment deleted successfully." | "Comment restored successfully."
}
```

### Error Responses

| Code | Message | Description |
|------|---------|-------------|
| 400 | Missing required fields | One or more required fields are missing |
| 400 | Invalid method. Allowed values: update, put, delete | Invalid method parameter |
| 400 | narrator_rate must be between 0 and 5 | Invalid narrator rating |
| 400 | book_rate must be between 0 and 5 | Invalid book rating |
| 400 | comment must be a string with a maximum of 2000 characters | Invalid comment format/length |
| 507 | The user is banned | User account is banned |
| 500 | Unexpected error | Server error |

### Example Requests

#### Create a Review
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/review \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "put",
    "book_guid": "book123",
    "comment": "Great book! Highly recommend.",
    "book_rate": 5,
    "narrator_rate": 4
  }'
```

#### Update a Review
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/review \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "update",
    "book_guid": "book123",
    "comment": "Updated comment text",
    "book_rate": 4,
    "narrator_rate": 5
  }'
```

#### Delete a Review
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/review \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "delete",
    "book_guid": "book123",
    "comment": "",
    "book_rate": 0,
    "narrator_rate": 0
  }'
```

---

## 2. Like Function

**Endpoint**: `https://europe-west2-<project-id>.cloudfunctions.net/like`

**Method**: `POST`

**Description**: Like or unlike a review/comment.

### Request Body

```json
{
  "comment_guid": "string",
  "method": "like" | "unlike"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `comment_guid` | string | Yes | Unique identifier for the comment (format: `{book_guid}_{user_guid}`) |
| `method` | string | Yes | Action to perform: `"like"` or `"unlike"` |

### Method Details

#### `like`
- Adds the comment owner to user's liked list
- Increments `num_of_likes` in the comment document
- User cannot like their own comment

#### `unlike`
- Removes the comment owner from user's liked list
- Decrements `num_of_likes` in the comment document (cannot go below 0)

### Success Response

```json
{
  "code": 200,
  "message": "Comment liked successfully." | "Comment unliked successfully."
}
```

### Error Responses

| Code | Message | Description |
|------|---------|-------------|
| 400 | Missing required fields | One or more required fields are missing |
| 400 | Invalid method. Must be 'like' or 'unlike' | Invalid method parameter |
| 400 | Invalid comment_guid | Invalid comment GUID format |
| 507 | The user is banned | User account is banned |
| 508 | Comment does not exist | Comment not found or is soft-deleted |
| 509 | User cannot like their own comment | Attempted to like own comment |
| 510 | User has already liked this comment | Attempted to like an already liked comment |
| 511 | User has not liked this comment | Attempted to unlike a comment that wasn't liked |
| 500 | Unexpected error | Server error |

### Example Requests

#### Like a Comment
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/like \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "comment_guid": "book123_user456",
    "method": "like"
  }'
```

#### Unlike a Comment
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/like \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "comment_guid": "book123_user456",
    "method": "unlike"
  }'
```

---

## 3. Flag Function

**Endpoint**: `https://europe-west2-<project-id>.cloudfunctions.net/flag`

**Method**: `POST`

**Description**: Flag or unflag a review/comment.

### Request Body

```json
{
  "comment_guid": "string",
  "method": "flag" | "unflag"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `comment_guid` | string | Yes | Unique identifier for the comment (format: `{book_guid}_{user_guid}`) |
| `method` | string | Yes | Action to perform: `"flag"` or `"unflag"` |

### Method Details

#### `flag`
- Adds the comment owner to user's flagged list
- Increments `num_of_flags` in the comment document
- User cannot flag their own comment
- User can only flag one comment per owner per book

#### `unflag`
- Removes the comment owner from user's flagged list
- Decrements `num_of_flags` in the comment document (cannot go below 0)

### Success Response

```json
{
  "code": 200,
  "message": "Comment flagged successfully." | "Comment unflagged successfully."
}
```

### Error Responses

| Code | Message | Description |
|------|---------|-------------|
| 400 | Missing required fields | One or more required fields are missing |
| 400 | Invalid method. Must be 'flag' or 'unflag' | Invalid method parameter |
| 400 | Invalid comment_guid | Invalid comment GUID format |
| 507 | The user is banned | User account is banned |
| 508 | Comment does not exist | Comment not found or is soft-deleted |
| 509 | User cannot flag their own comment | Attempted to flag own comment |
| 510 | User has already flagged this comment | Attempted to flag an already flagged comment |
| 511 | User has not flagged this comment before | Attempted to unflag a comment that wasn't flagged |
| 500 | Unexpected error | Server error |

### Example Requests

#### Flag a Comment
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/flag \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "comment_guid": "book123_user456",
    "method": "flag"
  }'
```

#### Unflag a Comment
```bash
curl -X POST https://europe-west2-<project-id>.cloudfunctions.net/flag \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "comment_guid": "book123_user456",
    "method": "unflag"
  }'
```

---

## Common Notes

1. **User Authentication**: All functions automatically extract `user_guid` from the Firebase ID token in the Authorization header.

2. **Banned Users**: All functions check if the user is banned before processing. Banned users receive error code 507.

3. **Soft Deleted Comments**: Comments marked with `is_deleted: true` are treated as non-existent for like and flag operations.

4. **Comment GUID Format**: The `comment_guid` for like and flag functions follows the pattern: `{book_guid}_{user_guid}` (e.g., `"book123_user456"`).

5. **Transaction Safety**: All operations use Firestore transactions to ensure data consistency.

6. **Rating Calculations**: 
   - Overall rating only averages rated dimensions (non-zero ratings)
   - If only book_rate is rated, overall_rate = book_rate
   - If only narrator_rate is rated, overall_rate = narrator_rate
   - If both are rated, overall_rate = (book_rate + narrator_rate) / 2

7. **Count Protection**: All counters (likes, flags, comment counts) are protected from going negative.

