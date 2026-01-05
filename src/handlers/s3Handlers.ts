import { Request } from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSecret, getSecretSSM, generateHashedFolderName } from "../utils/secrets";
import { S3UploadRequest } from "../types";
import { PRESIGNED_URL_EXPIRES_IN } from "../config/constants";

export async function handleS3Upload(req: Request): Promise<{
  code: number;
  message: string;
  data: {
    presigned_url: string;
    bucket_name: string;
    file_key: string;
    expires_in: number;
    bunny_key?: string;
  };
}> {
  const { bucket_name, region: s3_region, file_key, content_type, type, id } = req.body as S3UploadRequest;

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

  if (!bucket_name || !s3_region) {
    throw new Error("Missing required fields: bucket_name, region");
  }

  let final_file_key = file_key;

  if (!file_key) {
    if (!type || !id) {
      throw new Error("Either file_key must be provided, or both type and id must be provided");
    }

    if (type !== "pdf" && type !== "image") {
      throw new Error("Invalid type. Currently only 'pdf' and 'image' are supported");
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

