export interface AuthResult {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

export interface SubscriptionFields {
  subscription_id: string;
  amount_paid: string;
  payment_method: string;
  duration: string;
  account_sent_to: string;
  phone_number_sent_from?: string;
  notes?: string;
}

export interface MigrationFields {
  subscription_id: string;
  country_code: string;
  end_date_of_subscription: string;
  user_guid?: string;
}

export interface FileData {
  filepath: string;
  filename: string;
  mimeType: string;
}

export interface S3UploadRequest {
  bucket_name?: string;
  region?: string;
  file_key?: string;
  content_type?: string;
  type?: string;
  id?: string;
  multipart?: boolean;
  part_count?: number;
  upload_id?: string;
  parts?: Array<{
    part_number: number;
    etag: string;
  }>;
}

