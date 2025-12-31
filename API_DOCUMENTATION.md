# Firebase Cloud Functions API Documentation

This guide explains how to call the Firebase Cloud Functions from a TypeScript/TSX application.

## Prerequisites

1. Install Firebase SDK:
```bash
npm install firebase
```

2. Initialize Firebase in your app (create a `firebase.ts` or `firebaseConfig.ts` file):
```typescript
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

const firebaseConfig = {
  // Your Firebase config
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  projectId: "YOUR_PROJECT_ID",
  // ... other config
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const functions = getFunctions(app, 'europe-west2');
```

## TypeScript Types

Add these types to your project:

```typescript
// API Request Types
interface SubscriptionRequest {
  subscription_id: string;
  amount_paid: number | string;
  payment_method: string;
  duration: string;
  account_sent_to: string;
  phone_number_sent_from?: string; // Optional
  notes?: string; // Optional
  photo: File; // Image file
}

interface AdminS3UploadRequest {
  bucket_name: string;
  region: string; // AWS region (e.g., "us-east-1")
  file_key: string; // S3 object key/path
  content_type?: string; // Optional, defaults to "application/octet-stream"
}

// API Response Types
interface ApiSuccessResponse<T = any> {
  code: 200;
  message: string;
  data: T;
}

interface ApiErrorResponse {
  code: 400 | 401 | 403 | 405 | 500;
  message: string;
}

type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

interface SubscriptionResponseData {
  subscription_id: string;
  photo_link: string;
}

interface S3PresignedUrlResponseData {
  presigned_url: string;
  bucket_name: string;
  file_key: string;
  expires_in: number; // seconds
}
```

## Function 1: Egypt Subscription (With Authentication)

**Endpoint:** `egyptSubscription`  
**Method:** POST  
**Authentication:** Required (Bearer token)

### Usage

```typescript
import { signInWithEmailAndPassword } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from './firebaseConfig';

// First, authenticate the user
const userCredential = await signInWithEmailAndPassword(
  auth, 
  'user@example.com', 
  'password'
);

// Get the ID token
const idToken = await userCredential.user.getIdToken();

// Prepare form data
const formData = new FormData();
formData.append('subscription_id', 'SUB123456');
formData.append('amount_paid', '100.50');
formData.append('payment_method', 'bank_transfer');
formData.append('duration', '1_year');
formData.append('account_sent_to', 'account_123');
formData.append('phone_number_sent_from', '+201234567890'); // Optional
formData.append('notes', 'Payment notes here'); // Optional
formData.append('photo', photoFile); // File object

// Call the function
const response = await fetch(
  'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/egyptSubscription',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
    },
    body: formData,
  }
);

const result: ApiResponse<SubscriptionResponseData> = await response.json();

if (result.code === 200) {
  console.log('Success:', result.data);
  // result.data contains: { subscription_id, photo_link }
} else {
  console.error('Error:', result.message);
}
```

### Expected Response

**Success (200):**
```typescript
{
  code: 200,
  message: "Subscription submitted successfully for approval",
  data: {
    subscription_id: "SUB123456",
    photo_link: "subscriptions/user_guid_timestamp_filename.jpg"
  }
}
```

**Error Responses:**
- `401`: Missing or invalid authentication token
- `400`: Missing required fields
- `405`: Method not allowed (must be POST)
- `500`: Server error

---

## Function 2: Egypt Subscription (Without Authentication)

**Endpoint:** `egyptSubscriptionNoAuth`  
**Method:** POST  
**Authentication:** Not required

### Usage

```typescript
// Prepare form data (same as above, but include user_guid)
const formData = new FormData();
formData.append('subscription_id', 'SUB123456');
formData.append('amount_paid', '100.50');
formData.append('payment_method', 'bank_transfer');
formData.append('duration', '1_year');
formData.append('user_guid', 'user_guid_here'); // Required for no-auth version
formData.append('account_sent_to', 'account_123');
formData.append('phone_number_sent_from', '+201234567890'); // Optional
formData.append('notes', 'Payment notes here'); // Optional
formData.append('photo', photoFile);

const response = await fetch(
  'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/egyptSubscriptionNoAuth',
  {
    method: 'POST',
    body: formData,
  }
);

const result: ApiResponse<SubscriptionResponseData> = await response.json();
```

### Expected Response

Same as Function 1 above.

---

## Function 3: Admin Upload to S3

**Endpoint:** `admin_upload_to_S3`  
**Method:** POST  
**Authentication:** Required (Bearer token)  
**Authorization:** User must be in `users_adminv2` collection

### Usage

```typescript
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebaseConfig';

// Authenticate admin user
const userCredential = await signInWithEmailAndPassword(
  auth, 
  'admin@example.com', 
  'password'
);

const idToken = await userCredential.user.getIdToken();

// Prepare request
const requestData: AdminS3UploadRequest = {
  bucket_name: 'my-s3-bucket',
  region: 'us-east-1',
  file_key: 'uploads/my-file.jpg',
  content_type: 'image/jpeg', // Optional
};

const response = await fetch(
  'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/admin_upload_to_S3',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestData),
  }
);

const result: ApiResponse<S3PresignedUrlResponseData> = await response.json();

if (result.code === 200) {
  console.log('Presigned URL:', result.data.presigned_url);
  console.log('Expires in:', result.data.expires_in, 'seconds');
  
  // Use the presigned URL to upload file directly to S3
  const file = /* your file */;
  await fetch(result.data.presigned_url, {
    method: 'PUT',
    headers: {
      'Content-Type': result.data.content_type || 'application/octet-stream',
    },
    body: file,
  });
} else {
  console.error('Error:', result.message);
}
```

### Expected Response

**Success (200):**
```typescript
{
  code: 200,
  message: "Presigned URL generated successfully",
  data: {
    presigned_url: "https://my-s3-bucket.s3.amazonaws.com/uploads/my-file.jpg?...",
    bucket_name: "my-s3-bucket",
    file_key: "uploads/my-file.jpg",
    expires_in: 3600 // 1 hour in seconds
  }
}
```

**Error Responses:**
- `401`: Missing or invalid authentication token
- `403`: User is not an admin (not in users_adminv2 collection)
- `400`: Missing required fields (bucket_name, region, file_key)
- `405`: Method not allowed (must be POST)
- `500`: Server error

---

## React/TSX Example Component

Here's a complete React component example:

```tsx
import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebaseConfig';

const SubscriptionForm: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Authenticate user
      const userCredential = await signInWithEmailAndPassword(
        auth,
        'user@example.com',
        'password'
      );
      const idToken = await userCredential.user.getIdToken();

      // Get form data
      const formData = new FormData(e.currentTarget);
      const photoFile = formData.get('photo') as File;

      // Validate
      if (!photoFile || !photoFile.type.startsWith('image/')) {
        throw new Error('Please select an image file');
      }

      // Call API
      const response = await fetch(
        'https://europe-west2-YOUR-PROJECT.cloudfunctions.net/egyptSubscription',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${idToken}`,
          },
          body: formData,
        }
      );

      const result: ApiResponse<SubscriptionResponseData> = await response.json();

      if (result.code === 200) {
        setSuccess(true);
        console.log('Subscription submitted:', result.data);
      } else {
        throw new Error(result.message);
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Your form fields */}
      {error && <div className="error">{error}</div>}
      {success && <div className="success">Subscription submitted!</div>}
      <button type="submit" disabled={loading}>
        {loading ? 'Submitting...' : 'Submit'}
      </button>
    </form>
  );
};
```

## Error Handling Best Practices

```typescript
async function callFunction<T>(
  url: string,
  options: RequestInit,
  idToken?: string
): Promise<ApiResponse<T>> {
  try {
    const headers: HeadersInit = {
      ...options.headers,
    };

    if (idToken) {
      headers['Authorization'] = `Bearer ${idToken}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    const result: ApiResponse<T> = await response.json();

    if (result.code !== 200) {
      throw new Error(result.message);
    }

    return result;
  } catch (error: any) {
    console.error('API Error:', error);
    throw error;
  }
}
```

## Notes

1. **Authentication**: For authenticated endpoints, always get a fresh ID token before each request as tokens expire.
2. **File Uploads**: The subscription functions use `multipart/form-data` (FormData), not JSON.
3. **S3 Upload**: After getting the presigned URL, use a PUT request to upload the file directly to S3.
4. **Error Handling**: Always check the `code` field in the response to determine success or failure.
5. **Admin Access**: The `admin_upload_to_S3` function requires the user to exist in the `users_adminv2` Firestore collection.

