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
  country_code?: string;
  end_date_of_subscription?: string;
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
}

export type Quality = 64 | 128 | 256;

export type Reason = 'download' | 'stream' | 'sample';

export interface BookItem {
  bookGuid: string;
  quality: Quality;
  reason: Reason;
}

export interface GetUrlsRequest {
  books: BookItem[];
  platform: string;
  deviceId?: string;
  build_number?: string;
}

export interface RecordingUrl {
  name: string;
  duration: number;
  ext: string;
  url: string;
}

export interface BookUrlData {
  recordings: RecordingUrl[];
  expiresAt: string;
}

export interface GetUrlsResponse {
  code: number;
  message: string;
  data: Record<string, BookUrlData>;
}

export interface Book {
  guid: string;
  name: string;
  book_id_reference?: string;
  picture_url?: {
    thumbnail_url?: string;
  };
  num_downloads?: number;
}

export interface Recording {
  name: string;
  duration: number;
  url_list: Record<string, string>;
}

export interface Settings {
  isNoAuthAllowed?: boolean;
  subscription?: SubscriptionSettings;
}

export interface SubscriptionSettings {
  max_number_of_devices?: number;
  days_before_replacing_device?: number;
}

