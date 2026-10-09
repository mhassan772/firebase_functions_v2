/**
 * Types for the per-book recording URL endpoints (downloadHttpV3, streamHttp,
 * sampleHttp) and the popular-books job, which predate this repo.
 */

export type Quality = "16" | "32" | "64";

/** Body of a downloadHttpV3, streamHttp or sampleHttp request. */
export interface RecordingUrlsRequest {
  narratorGuid: string;
  bookGuid: string;
  quality: Quality;
  platform: string;
  deviceId?: string;
}

export interface RecordingUrl {
  name: string;
  duration: number;
  ext?: string;
  url: string;
}

export interface RecordingUrlsResponse {
  code: number;
  message: string;
  data: RecordingUrl[];
  remainingDownloads?: number;
  remainingHours?: number;
}

/** Fields read from `settings/mantooqAppSettings`. */
export interface AppSettings {
  storageBucketNameFirebase: string;
  mp3CloudFrontSigningPrivateKeyFileName: string;
  /** Days of listening the popular books chart counts. Defaults to 30. */
  mostPopularBooksDays?: number;
  /** Books kept in the popular books chart. Defaults to 100. */
  numberOfMostPopularBooksToReturn?: number;
  /** No longer read: the download audit it pruned is no longer written. */
  numberOfDaysToDeleteMostPopularBooksAfter?: number;
  /** Lifetime listening on a book, in seconds, that makes someone its listener. Defaults to 300. */
  popularBooksMinListenSeconds?: number;
  /** Below this many books the previous popular books chart is kept. Defaults to 20. */
  popularBooksMinChartSize?: number;
  /** Days of podcast audit records the podcast rankings count. Defaults to 60. */
  popularPodcastsDays?: number;
  /** Days podcast audit records are kept before pruning. Defaults to 65, never below the window plus a day. */
  popularPodcastsAuditRetentionDays?: number;
  /** Entries kept in each podcast ranking. Defaults to 50. */
  numberOfPopularPodcastsToReturn?: number;
}

export type Narrators = {
  duration: number;
  narrator_guid: string;
  narrator_name: string;
  size_16: number;
  size_32: number;
  size_64: number;
};

/** A document in the `books` collection. */
export interface Book {
  guid: string;
  author_details: { author_guid: string; author_name: string };
  book_id_reference: number;
  category_details: { category_guid: string; category_name: string };
  date_added: Date;
  description: string;
  goodreads_url: string;
  is_book_hidden: boolean;
  name: string;
  narrators: [Narrators];
  num_downloads: number;
  num_votes_for_recording: number;
  picture_url: { highres_url: string; thumbnail_url: string };
  publisher: string;
  tags_list: [string];
  verification_status: string;
}

/** One chapter inside a `book_recordings` document. */
export interface Recording {
  name: string;
  duration: number;
  url_list: {
    "16kb_url": string;
    "32kb_url": string;
    "64kb_url": string;
  };
}
