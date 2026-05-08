import { Request } from "express";
import Busboy from "busboy";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { STORAGE_BUCKET } from "../config/constants";
import { FileData } from "../types";

type AffectOfIssue = "simple" | "annoying" | "severe";
type DeviceType = "ios" | "android";
type MediaType = "image" | "video" | "log";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_REQUEST_BYTES = 65 * 1024 * 1024; // 65MB
const ALLOWED_LOG_FILE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-tar",
]);
const ALLOWED_LOG_FILE_EXTENSIONS = [".zip", ".gz", ".gzip", ".7z", ".rar", ".tar"];

class RequestValidationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "RequestValidationError";
    this.statusCode = statusCode;
  }
}

function parseOptionalBoolean(value?: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new RequestValidationError("Invalid isPremium. Must be true or false", 400);
}

interface ReportIssueResponse {
  code: number;
  message: string;
  data: {
    issue_id: string;
    media_link: string | null;
    log_file_link: string | null;
  };
}

function isAllowedLogFile(filename: string, mimeType: string): boolean {
  const normalizedMimeType = mimeType.toLowerCase();
  if (ALLOWED_LOG_FILE_MIME_TYPES.has(normalizedMimeType)) {
    return true;
  }

  const extension = path.extname(filename).toLowerCase();
  return ALLOWED_LOG_FILE_EXTENSIONS.includes(extension);
}

export async function handleReportIssue(
  req: Request,
  authenticatedUserGuid: string
): Promise<ReportIssueResponse> {
  return new Promise((resolve, reject) => {
    const contentLengthHeader = req.headers["content-length"];
    const contentLength = typeof contentLengthHeader === "string" ? parseInt(contentLengthHeader, 10) : NaN;
    if (!Number.isNaN(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      reject(new RequestValidationError("Request exceeds 65MB limit", 413));
      return;
    }

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 2,
        fileSize: MAX_VIDEO_BYTES,
      },
    });
    const fields: Record<string, string> = {};
    let mediaFileData: FileData | null = null;
    let logFileData: FileData | null = null;
    const tmpdir = os.tmpdir();
    let hasFinished = false;
    let mediaUploadedBytes = 0;
    let logUploadedBytes = 0;

    const rejectOnce = (error: Error): void => {
      if (hasFinished) {
        return;
      }
      hasFinished = true;
      reject(error);
    };

    busboy.on("field", (fieldname: string, val: string) => {
      fields[fieldname] = val;
    });

    busboy.on("file", (fieldname: string, file: any, info: { filename: string; encoding: string; mimeType: string }) => {
      const safeFilename = path.basename(info.filename);
      const isMediaField = fieldname === "media";
      const isLogFileField = fieldname === "log_file";

      if (!isMediaField && !isLogFileField) {
        file.resume();
        rejectOnce(new RequestValidationError("Unsupported file field. Allowed file fields are media and log_file", 400));
        return;
      }

      if (isMediaField) {
        const isImage = info.mimeType.startsWith("image/");
        const isVideo = info.mimeType.startsWith("video/");
        if (!isImage && !isVideo) {
          file.resume();
          rejectOnce(new RequestValidationError("Media must be an image or video", 400));
          return;
        }

        const mediaType: MediaType = isImage ? "image" : "video";
        const filepath = path.join(tmpdir, `media_${safeFilename}`);
        mediaFileData = { filepath, filename: safeFilename, mimeType: info.mimeType };
        const writeStream = fs.createWriteStream(filepath);

        file.on("data", (chunk: Buffer) => {
          mediaUploadedBytes += chunk.length;
          if (mediaType === "image" && mediaUploadedBytes > MAX_IMAGE_BYTES) {
            writeStream.destroy();
            file.resume();
            rejectOnce(new RequestValidationError("Image exceeds 10MB limit", 413));
          }
        });

        file.on("limit", () => {
          writeStream.destroy();
          file.resume();
          rejectOnce(new RequestValidationError("Video exceeds 50MB limit", 413));
        });

        file.pipe(writeStream);
        return;
      }

      if (!isAllowedLogFile(safeFilename, info.mimeType)) {
        file.resume();
        rejectOnce(new RequestValidationError("log_file must be a compressed file (zip, rar, 7z, gz, tar)", 400));
        return;
      }

      const filepath = path.join(tmpdir, `log_${safeFilename}`);
      logFileData = { filepath, filename: safeFilename, mimeType: info.mimeType };
      const writeStream = fs.createWriteStream(filepath);

      file.on("data", (chunk: Buffer) => {
        logUploadedBytes += chunk.length;
        if (logUploadedBytes > MAX_LOG_FILE_BYTES) {
          writeStream.destroy();
          file.resume();
          rejectOnce(new RequestValidationError("log_file exceeds 10MB limit", 413));
        }
      });

      file.pipe(writeStream);
    });

    busboy.on("filesLimit", () => {
      rejectOnce(new RequestValidationError("Maximum two files are allowed: media and log_file", 400));
    });

    busboy.on("finish", async () => {
      if (hasFinished) {
        return;
      }
      try {
        const issue = fields.issue?.trim();
        const affect_of_issue = fields.affect_of_issue?.trim().toLowerCase() as AffectOfIssue;
        const device_type = fields.device_type?.trim().toLowerCase() as DeviceType;
        const app_version = fields.app_version?.trim();
        const contact_method = fields.contact_method?.trim();
        const email = fields.email?.trim();
        const deviceName = fields.deviceName?.trim();
        const buildNumber = fields.buildNumber?.trim();
        const osVersion = fields.osVersion?.trim();
        const isPremium = parseOptionalBoolean(fields.isPremium);
        const user_guid = authenticatedUserGuid;

        if (!issue || !affect_of_issue || !device_type || !app_version || !user_guid) {
          rejectOnce(new RequestValidationError("Missing required fields: issue, affect_of_issue, device_type, app_version, user_guid", 400));
          return;
        }

        if (!["simple", "annoying", "severe"].includes(affect_of_issue)) {
          rejectOnce(new RequestValidationError("Invalid affect_of_issue. Must be one of: simple, annoying, severe", 400));
          return;
        }

        if (!["ios", "android"].includes(device_type)) {
          rejectOnce(new RequestValidationError("Invalid device_type. Must be either ios or android", 400));
          return;
        }

        let media_link: string | null = null;
        let log_file_link: string | null = null;
        const bucket = admin.storage().bucket(STORAGE_BUCKET);

        if (mediaFileData) {
          const timestamp = Date.now();
          const storagePath = `reportingIssues/${user_guid}_${timestamp}_${mediaFileData.filename}`;

          await bucket.upload(mediaFileData.filepath, {
            destination: storagePath,
            metadata: {
              contentType: mediaFileData.mimeType,
            },
          });

          media_link = storagePath;
          fs.unlinkSync(mediaFileData.filepath);
        }

        if (logFileData) {
          const timestamp = Date.now();
          const storagePath = `logFiles/${user_guid}_${timestamp}_${logFileData.filename}`;

          await bucket.upload(logFileData.filepath, {
            destination: storagePath,
            metadata: {
              contentType: logFileData.mimeType,
            },
          });

          log_file_link = storagePath;
          fs.unlinkSync(logFileData.filepath);
        }

        const issueReportData: Record<string, unknown> = {
          issue,
          affect_of_issue,
          device_type,
          app_version,
          user_guid,
          state: "pending",
          media_link,
          log_file_link,
          created_at: Timestamp.now(),
        };

        if (contact_method) {
          issueReportData.contact_method = contact_method;
        }
        if (email) {
          issueReportData.email = email;
        }
        if (deviceName) {
          issueReportData.deviceName = deviceName;
        }
        if (buildNumber) {
          issueReportData.buildNumber = buildNumber;
        }
        if (osVersion) {
          issueReportData.osVersion = osVersion;
        }
        if (isPremium !== undefined) {
          issueReportData.isPremium = isPremium;
        }

        const docRef = await admin.firestore().collection("reporting_issues").add(issueReportData);

        resolve({
          code: 200,
          message: "Issue reported successfully",
          data: {
            issue_id: docRef.id,
            media_link,
            log_file_link,
          },
        });
      } catch (error) {
        if (mediaFileData && fs.existsSync(mediaFileData.filepath)) {
          fs.unlinkSync(mediaFileData.filepath);
        }
        if (logFileData && fs.existsSync(logFileData.filepath)) {
          fs.unlinkSync(logFileData.filepath);
        }
        rejectOnce(error as Error);
      }
    });

    busboy.on("error", (error: Error) => {
      rejectOnce(error);
    });

    busboy.end((req as any).rawBody);
  });
}
