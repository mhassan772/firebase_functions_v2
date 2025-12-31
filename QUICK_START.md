# Quick Start Guide - Firebase Cloud Functions

## Setup

```bash
npm install firebase
```

## Get Authentication Token

```typescript
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebaseConfig';

const userCredential = await signInWithEmailAndPassword(auth, email, password);
const idToken = await userCredential.user.getIdToken();
```

## 1. Egypt Subscription (With Auth)

```typescript
const formData = new FormData();
formData.append('subscription_id', 'SUB123');
formData.append('amount_paid', '100.50');
formData.append('payment_method', 'bank_transfer');
formData.append('duration', '1_year');
formData.append('account_sent_to', 'account_123');
formData.append('phone_number_sent_from', '+201234567890'); // Optional
formData.append('notes', 'Notes here'); // Optional
formData.append('photo', photoFile); // Image file

const response = await fetch(
  'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/egyptSubscription',
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${idToken}` },
    body: formData,
  }
);

const result = await response.json();
// Success: { code: 200, message: "...", data: { subscription_id, photo_link } }
```

## 2. Egypt Subscription (No Auth)

```typescript
const formData = new FormData();
formData.append('subscription_id', 'SUB123');
formData.append('amount_paid', '100.50');
formData.append('payment_method', 'bank_transfer');
formData.append('duration', '1_year');
formData.append('user_guid', 'user_guid_here'); // Required
formData.append('account_sent_to', 'account_123');
formData.append('phone_number_sent_from', '+201234567890'); // Optional
formData.append('notes', 'Notes here'); // Optional
formData.append('photo', photoFile);

const response = await fetch(
  'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/egyptSubscriptionNoAuth',
  { method: 'POST', body: formData }
);
```

## 3. Admin Upload to S3

```typescript
const response = await fetch(
  'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/admin_upload_to_S3',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucket_name: 'my-bucket',
      region: 'us-east-1',
      file_key: 'uploads/file.jpg',
      content_type: 'image/jpeg', // Optional
    }),
  }
);

const result = await response.json();
// Success: { code: 200, data: { presigned_url, bucket_name, file_key, expires_in } }

// Upload file to S3 using presigned URL
await fetch(result.data.presigned_url, {
  method: 'PUT',
  headers: { 'Content-Type': result.data.content_type || 'application/octet-stream' },
  body: file,
});
```

## Response Format

All functions return:
```typescript
{
  code: 200 | 400 | 401 | 403 | 405 | 500,
  message: string,
  data?: any // Only present on success (code 200)
}
```

## Error Codes

- `200`: Success
- `400`: Bad Request (missing/invalid fields)
- `401`: Unauthorized (invalid/missing token)
- `403`: Forbidden (not admin for S3 function)
- `405`: Method not allowed
- `500`: Server error

