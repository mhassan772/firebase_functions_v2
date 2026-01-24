import { Request } from "express";
import { 
  S3Client, 
  PutObjectCommand, 
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSecret, getSecretSSM, generateHashedFolderName } from "../utils/secrets";
import { S3UploadRequest } from "../types";
import { PRESIGNED_URL_EXPIRES_IN } from "../config/constants";
import { admin } from "../config/admin";

export async function handleS3Upload(req: Request): Promise<{
  code: number;
  message: string;
  data: any;
}> {
  const { bucket_name, region: s3_region, file_key, content_type, type, id, multipart, upload_id, parts } = req.body as S3UploadRequest;

  if (type === "books_database") {
    const bunny_key = await getSecret("bunny_book_database_API");
    return {
      code: 200,
      message: "Bunny key retrieved successfully",
      data: {
        presigned_url: "",
        bucket_name: "",
        file_key: "",
        expires_in: 0,
        bunny_key: bunny_key,
      },
    };
  }

  // Handle multipart upload completion
  if (upload_id && parts && parts.length > 0) {
    return await handleMultipartComplete(req, type);
  }

  // Handle multipart upload initiation
  if (multipart) {
    return await handleMultipartInitiate(req, type);
  }

  if (type === "podcasts") {
    if (!file_key) {
      throw new Error("file_key is required for podcasts type");
    }

    const podcastsSettingsDoc = await admin.firestore()
      .collection("settings")
      .doc("podcasts")
      .get();

    if (!podcastsSettingsDoc.exists) {
      throw new Error("Podcasts settings not found in Firestore");
    }

    const podcastsSettings = podcastsSettingsDoc.data();
    const r2_bucket_name = podcastsSettings?.bucket;
    const r2_endpoint = podcastsSettings?.r2_endpoint;

    if (!r2_bucket_name || !r2_endpoint) {
      throw new Error("Missing bucket or r2_endpoint in podcasts settings");
    }

    const r2_access_key_id = await getSecret("r2_podcasts_access_key_id");
    const r2_secret_access_key = await getSecret("r2_podcasts_secret_access_key");

    const s3Client = new S3Client({
      region: "auto",
      endpoint: r2_endpoint,
      credentials: {
        accessKeyId: r2_access_key_id,
        secretAccessKey: r2_secret_access_key,
      },
    });

    const command = new PutObjectCommand({
      Bucket: r2_bucket_name,
      Key: file_key,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_URL_EXPIRES_IN });

    return {
      code: 200,
      message: "Presigned URL generated successfully",
      data: {
        presigned_url: presignedUrl,
        bucket_name: r2_bucket_name,
        file_key: file_key,
        expires_in: PRESIGNED_URL_EXPIRES_IN,
      },
    };
  }

  if (!bucket_name || !s3_region) {
    throw new Error("Missing required fields: bucket_name, region");
  }

  let final_file_key = file_key;

  if (!file_key) {
    if (!type || !id) {
      throw new Error("Either file_key must be provided, or both type and id must be provided");
    }

    if (type !== "pdf" && type !== "image") {
      throw new Error("Invalid type. Currently only 'pdf', 'image', and 'podcasts' are supported");
    }

    if (type === "pdf") {
      const secret = await getSecretSSM("mp3-book-seed");
      const hashedFolderName = generateHashedFolderName(secret, String(id), type);
      final_file_key = `${id}/${hashedFolderName}/1.pdf`;
    } else if (type === "image") {
      const secret = await getSecretSSM("book-picture-seed");
      const hashedFolderName = generateHashedFolderName(secret, String(id));
      final_file_key = `images/${id}/${hashedFolderName}/${id}.webp`;
    }
  }

  const access_key_id = await getSecret("aws_access_key_id");
  const secret_access_key = await getSecret("aws_secret_access_key");

  const s3Client = new S3Client({
    region: s3_region,
    credentials: {
      accessKeyId: access_key_id,
      secretAccessKey: secret_access_key,
    },
  });

  const command = new PutObjectCommand({
    Bucket: bucket_name,
    Key: final_file_key,
    ContentType: content_type || 'application/octet-stream',
  });

  const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_URL_EXPIRES_IN });

  const responseData: any = {
    presigned_url: presignedUrl,
    bucket_name,
    file_key: final_file_key,
    expires_in: PRESIGNED_URL_EXPIRES_IN,
  };

  if (type === "pdf") {
    const bunny_key = await getSecret("bunny_api_pdf");
    responseData.bunny_key = bunny_key;
  }

  return {
    code: 200,
    message: "Presigned URL generated successfully",
    data: responseData,
  };
}

async function handleMultipartInitiate(req: Request, type?: string): Promise<{
  code: number;
  message: string;
  data: any;
}> {
  const { bucket_name, region: s3_region, file_key, content_type, part_count } = req.body as S3UploadRequest;

  if (!file_key) {
    throw new Error("file_key is required for multipart upload");
  }

  let s3Client: S3Client;
  let final_bucket_name: string;

  if (type === "podcasts") {
    const podcastsSettingsDoc = await admin.firestore()
      .collection("settings")
      .doc("podcasts")
      .get();

    if (!podcastsSettingsDoc.exists) {
      throw new Error("Podcasts settings not found in Firestore");
    }

    const podcastsSettings = podcastsSettingsDoc.data();
    const r2_bucket_name = podcastsSettings?.bucket;
    const r2_endpoint = podcastsSettings?.r2_endpoint;

    if (!r2_bucket_name || !r2_endpoint) {
      throw new Error("Missing bucket or r2_endpoint in podcasts settings");
    }

    const r2_access_key_id = await getSecret("r2_podcasts_access_key_id");
    const r2_secret_access_key = await getSecret("r2_podcasts_secret_access_key");

    s3Client = new S3Client({
      region: "auto",
      endpoint: r2_endpoint,
      credentials: {
        accessKeyId: r2_access_key_id,
        secretAccessKey: r2_secret_access_key,
      },
    });

    final_bucket_name = r2_bucket_name;
  } else {
    if (!bucket_name || !s3_region) {
      throw new Error("Missing required fields: bucket_name, region");
    }

    const access_key_id = await getSecret("aws_access_key_id");
    const secret_access_key = await getSecret("aws_secret_access_key");

    s3Client = new S3Client({
      region: s3_region,
      credentials: {
        accessKeyId: access_key_id,
        secretAccessKey: secret_access_key,
      },
    });

    final_bucket_name = bucket_name;
  }

  // Create multipart upload
  const createCommand = new CreateMultipartUploadCommand({
    Bucket: final_bucket_name,
    Key: file_key,
    ContentType: content_type,
  });

  const createResponse = await s3Client.send(createCommand);
  const uploadId = createResponse.UploadId;

  if (!uploadId) {
    throw new Error("Failed to create multipart upload");
  }

  // Calculate number of parts (default to 5 if not provided)
  const numParts = part_count || 5;

  // Generate presigned URLs for each part
  const partUrls: Array<{ part_number: number; url: string }> = [];
  for (let partNumber = 1; partNumber <= numParts; partNumber++) {
    const uploadPartCommand = new UploadPartCommand({
      Bucket: final_bucket_name,
      Key: file_key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const partUrl = await getSignedUrl(s3Client, uploadPartCommand, { expiresIn: PRESIGNED_URL_EXPIRES_IN });
    partUrls.push({
      part_number: partNumber,
      url: partUrl,
    });
  }

  return {
    code: 200,
    message: "Multipart upload initiated successfully",
    data: {
      upload_id: uploadId,
      bucket_name: final_bucket_name,
      file_key: file_key,
      part_urls: partUrls,
      expires_in: PRESIGNED_URL_EXPIRES_IN,
    },
  };
}

async function handleMultipartComplete(req: Request, type?: string): Promise<{
  code: number;
  message: string;
  data: any;
}> {
  const { bucket_name, region: s3_region, file_key, upload_id, parts } = req.body as S3UploadRequest;

  if (!file_key || !upload_id || !parts || parts.length === 0) {
    throw new Error("Missing required fields: file_key, upload_id, and parts");
  }

  let s3Client: S3Client;
  let final_bucket_name: string;

  if (type === "podcasts") {
    const podcastsSettingsDoc = await admin.firestore()
      .collection("settings")
      .doc("podcasts")
      .get();

    if (!podcastsSettingsDoc.exists) {
      throw new Error("Podcasts settings not found in Firestore");
    }

    const podcastsSettings = podcastsSettingsDoc.data();
    const r2_bucket_name = podcastsSettings?.bucket;
    const r2_endpoint = podcastsSettings?.r2_endpoint;

    if (!r2_bucket_name || !r2_endpoint) {
      throw new Error("Missing bucket or r2_endpoint in podcasts settings");
    }

    const r2_access_key_id = await getSecret("r2_podcasts_access_key_id");
    const r2_secret_access_key = await getSecret("r2_podcasts_secret_access_key");

    s3Client = new S3Client({
      region: "auto",
      endpoint: r2_endpoint,
      credentials: {
        accessKeyId: r2_access_key_id,
        secretAccessKey: r2_secret_access_key,
      },
    });

    final_bucket_name = r2_bucket_name;
  } else {
    if (!bucket_name || !s3_region) {
      throw new Error("Missing required fields: bucket_name, region");
    }

    const access_key_id = await getSecret("aws_access_key_id");
    const secret_access_key = await getSecret("aws_secret_access_key");

    s3Client = new S3Client({
      region: s3_region,
      credentials: {
        accessKeyId: access_key_id,
        secretAccessKey: secret_access_key,
      },
    });

    final_bucket_name = bucket_name;
  }

  // Complete multipart upload
  const completeCommand = new CompleteMultipartUploadCommand({
    Bucket: final_bucket_name,
    Key: file_key,
    UploadId: upload_id,
    MultipartUpload: {
      Parts: parts.map(part => ({
        PartNumber: part.part_number,
        ETag: part.etag,
      })),
    },
  });

  const completeResponse = await s3Client.send(completeCommand);

  return {
    code: 200,
    message: "Multipart upload completed successfully",
    data: {
      bucket_name: final_bucket_name,
      file_key: file_key,
      location: completeResponse.Location,
      etag: completeResponse.ETag,
    },
  };
}
