# Egypt Subscription Firebase Cloud Functions

This project contains Firebase Cloud Functions for handling Egypt subscription requests with file upload capabilities.

## Features

- **egyptSubscription**: Authenticated endpoint for subscription submissions
- **egyptSubscriptionNoAuth**: Non-authenticated endpoint for subscription submissions
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
- Authentication enabled (for the authenticated endpoint)

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

### 1. Egypt Subscription (Authenticated)
- **URL**: `https://europe-west2-your-project-id.cloudfunctions.net/egyptSubscription`
- **Method**: POST
- **Authentication**: Required (Bearer token in Authorization header)
- **Content-Type**: multipart/form-data

**Form Fields:**
- `subscription_id` (string, required)
- `amount_paid` (number, required)
- `payment_method` (string, required)
- `photo` (file, required) - Image file

### 2. Egypt Subscription (No Auth)
- **URL**: `https://europe-west2-your-project-id.cloudfunctions.net/egyptSubscriptionNoAuth`
- **Method**: POST
- **Authentication**: Not required
- **Content-Type**: multipart/form-data

**Form Fields:**
- `subscription_id` (string, required)
- `amount_paid` (number, required)
- `payment_method` (string, required)
- `user_guid` (string, required)
- `photo` (file, required) - Image file

## Response Format

**Success Response:**
```json
{
  "code": 200,
  "message": "Subscription submitted successfully for approval",
  "data": {
    "subscription_id": "sub_123",
    "photo_link": "subscriptions/user123_1234567890_photo.jpg"
  }
}
```

**Error Response:**
```json
{
  "code": 400,
  "message": "Missing required fields: subscription_id, amount_paid, payment_method"
}
```

## Data Storage

- **Firestore Collection**: `subscriptions_to_be_approved`
- **Storage Bucket**: `mantooq-images-p`
- **Storage Path**: `subscriptions/{user_guid}_{timestamp}_{filename}`

## Security Notes

- The authenticated endpoint validates Firebase ID tokens
- File uploads are validated to ensure they are images only
- Temporary files are cleaned up after processing
- Storage paths are not publicly accessible by default

## Troubleshooting

### Common Issues

1. **Authentication Errors**: Ensure the Firebase ID token is valid and not expired
2. **File Upload Errors**: Make sure the file is an image and under the size limit
3. **Storage Errors**: Verify the Firebase Storage bucket exists and has proper permissions
4. **Firestore Errors**: Ensure Firestore is enabled and has proper security rules

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
egypt-subscription-functions/
├── index.js                 # Main Cloud Functions file
├── authentication.js        # Authentication helper
├── package.json            # Dependencies and scripts
├── firebase.json           # Firebase configuration
├── .firebaserc            # Firebase project configuration
├── .gitignore             # Git ignore rules
└── README.md              # This file
```
