# Firebase Cloud Functions V2

This project contains Firebase Cloud Functions for handling subscription requests, migration restoration, and admin S3 upload operations.

## Features

- **egyptSubscription**: Authenticated endpoint for subscription submissions
- **restoreSubscriptionMigration**: Authenticated endpoint for subscription migration restoration
- **admin_upload_to_S3**: Admin endpoint for generating S3 presigned URLs
- File upload support for subscription photos
- Firebase Storage integration
- Firestore database integration
- Input validation and error handling

## Prerequisites

- Node.js 18 or higher
- Firebase CLI installed (`npm install -g firebase-tools`)
- Firebase project with Firestore and Storage enabled
- Service account key for Firebase Admin SDK

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Firebase Configuration

1. Update `.firebaserc` with your Firebase project ID:
   ```json
   {
     "projects": {
       "default": "your-actual-firebase-project-id"
     }
   }
   ```

2. Set up Firebase service account:
   - Go to Firebase Console > Project Settings > Service Accounts
   - Generate a new private key
   - Save it as `service-account-key.json` in the project root
   - **Important**: Add this file to `.gitignore` (already included)

### 3. Environment Setup

The functions will automatically initialize Firebase Admin SDK. Make sure your Firebase project has:
- Firestore database enabled
- Cloud Storage enabled with bucket named `mantooq-images-p`
- Authentication enabled (for authenticated endpoints)

### 4. Local Development

```bash
# Start Firebase emulators
npm run serve

# Or use Firebase CLI directly
firebase emulators:start --only functions
```

### 5. Deploy to Firebase

```bash
# Deploy functions
npm run deploy

# Or use Firebase CLI directly
firebase deploy --only functions
```

## API Endpoints

### 1. Egypt Subscription

**Endpoint:** `egyptSubscription`  
**Method:** POST  
**Authentication:** Required (Bearer token in Authorization header)  
**Content-Type:** multipart/form-data

**Form Fields:**
- `subscription_id` (string, required) - Subscription identifier
- `amount_paid` (number, required) - Amount paid for subscription
- `payment_method` (string, required) - Payment method used
- `duration` (string, required) - Subscription duration
- `account_sent_to` (string, required) - Account where payment was sent
- `phone_number_sent_from` (string, optional) - Phone number used for payment
- `notes` (string, optional) - Additional notes
- `photo` (file, required) - Image file of payment proof

**Note:** `user_guid` is automatically extracted from the authentication token.

**Success Response (200):**
```json
{
  "code": 200,
  "message": "Subscription submitted successfully for approval",
  "data": {
    "subscription_id": "sub_123",
    "photo_link": "subscriptions/user_guid_timestamp_filename.jpg"
  }
}
```

**Data Storage:**
- **Firestore Collection:** `subscriptions_to_be_approved`
- **Storage Bucket:** `mantooq-images-p`
- **Storage Path:** `subscriptions/{user_guid}_{timestamp}_{filename}`
- **Status:** All submissions are stored with `status: "pending"`

---

### 2. Restore Subscription Migration

**Endpoint:** `restoreSubscriptionMigration`  
**Method:** POST  
**Authentication:** Required (Bearer token in Authorization header)  
**Content-Type:** multipart/form-data

**Form Fields:**
- `subscription_id` (string, required) - Subscription identifier
- `country_code` (string, required) - Country code (e.g., "EG", "US")
- `end_date_of_subscription` (string, required) - End date of subscription (e.g., "2024-12-31")
- `photo` (file, required) - Image file

**Note:** `user_guid` is automatically extracted from the authentication token.

**Success Response (200):**
```json
{
  "code": 200,
  "message": "Subscription migration restoration submitted successfully",
  "data": {
    "subscription_id": "sub_123",
    "photo_link": "restoreSubscriptionMigration/user_guid_timestamp_filename.jpg"
  }
}
```

**Data Storage:**
- **Firestore Collection:** `subscription_migration_restoration`
- **Storage Bucket:** `mantooq-images-p`
- **Storage Path:** `restoreSubscriptionMigration/{user_guid}_{timestamp}_{filename}`
- **Status:** All submissions are stored with `status: "pending"`

---

### 3. Admin Upload to S3

**Endpoint:** `admin_upload_to_S3`  
**Method:** POST  
**Authentication:** Required (Bearer token in Authorization header)  
**Authorization:** Admin only (user must exist in `users_adminv2` collection)  
**Content-Type:** application/json

**Request Body:**
```json
{
  "bucket_name": "your-bucket-name",
  "region": "eu-west-1",
  "file_key": "optional/custom/path/file.pdf",
  "content_type": "application/pdf",
  "type": "pdf",
  "id": "12345"
}
```

**Parameters:**
- `bucket_name` (string, required) - S3 bucket name
- `region` (string, required) - AWS region (e.g., "eu-west-1")
- `file_key` (string, optional) - Custom file path in S3. If not provided, `type` and `id` must be provided
- `content_type` (string, optional) - MIME type of the file (defaults to "application/octet-stream")
- `type` (string, optional) - Type of file: "pdf" or "image". Required if `file_key` is not provided
- `id` (string, optional) - ID for generating file path. Required if `file_key` is not provided

**Special Case - Books Database:**
```json
{
  "type": "books_database"
}
```
Returns Bunny CDN API key for books database.

**Success Response (200):**
```json
{
  "code": 200,
  "message": "Presigned URL generated successfully",
  "data": {
    "presigned_url": "https://...",
    "bucket_name": "your-bucket-name",
    "file_key": "generated/path/file.pdf",
    "expires_in": 3600,
    "bunny_key": "..." // Only included if type is "pdf"
  }
}
```

**File Path Generation:**
- **PDF files:** `{id}/{hashed_folder_name}/1.pdf`
- **Images:** `images/{id}/{hashed_folder_name}/{id}.webp`
- Hash is generated using secrets from AWS SSM Parameter Store

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "code": 400,
  "message": "Missing required fields: subscription_id, amount_paid"
}
```

**Common Error Codes:**
- `400`: Bad Request - Missing or invalid fields
- `401`: Unauthorized - Missing or invalid authentication token
- `403`: Forbidden - User is not an admin (admin_upload_to_S3 only)
- `405`: Method Not Allowed - Must use POST method
- `500`: Internal Server Error

## Security Notes

- Authenticated endpoints validate Firebase ID tokens
- Admin endpoints verify user exists in `users_adminv2` collection
- File uploads are validated to ensure they are images only (for subscription endpoints)
- Temporary files are cleaned up after processing
- Storage paths are not publicly accessible by default
- S3 presigned URLs expire after 1 hour

## Troubleshooting

### Common Issues

1. **Authentication Errors**: Ensure the Firebase ID token is valid and not expired
2. **File Upload Errors**: Make sure the file is an image and under the size limit
3. **Storage Errors**: Verify the Firebase Storage bucket exists and has proper permissions
4. **Firestore Errors**: Ensure Firestore is enabled and has proper security rules
5. **Admin Access Errors**: Verify the user exists in the `users_adminv2` collection

### Logs

View function logs:
```bash
npm run logs
```

Or use Firebase CLI:
```bash
firebase functions:log
```

## Project Structure

```
firebase_functions_v2/
├── index.js                 # Main Cloud Functions file
├── authentication.js        # Authentication helper
├── package.json            # Dependencies and scripts
├── firebase.json           # Firebase configuration
├── .firebaserc            # Firebase project configuration
├── .gitignore             # Git ignore rules
└── README.md              # This file
```
