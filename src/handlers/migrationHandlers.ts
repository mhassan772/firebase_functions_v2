import { Request } from "express";
import Busboy from "busboy";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { admin } from "../config/admin";
import { Timestamp } from "firebase-admin/firestore";
import { STORAGE_BUCKET } from "../config/constants";
import { FileData } from "../types";

export async function handleRestoreSubscriptionMigration(
  req: Request,
  authenticatedUserGuid: string
): Promise<{ code: number; message: string; data: { subscription_id: string; photo_link: string } }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let fileData: FileData | null = null;
    const tmpdir = os.tmpdir();

    busboy.on('field', (fieldname: string, val: string) => {
      fields[fieldname] = val;
    });

    busboy.on('file', (fieldname: string, file: any, info: { filename: string; encoding: string; mimeType: string }) => {
      const { filename, mimeType } = info;

      if (!mimeType.startsWith('image/')) {
        reject(new Error("File must be an image"));
        return;
      }

      const filepath = path.join(tmpdir, filename);
      fileData = { filepath, filename, mimeType };

      file.pipe(fs.createWriteStream(filepath));
    });

    busboy.on('finish', async () => {
      try {
        const { subscription_id, country_code, end_date_of_subscription } = fields;
        const user_guid = authenticatedUserGuid;

        if (!subscription_id || !country_code || !end_date_of_subscription || !user_guid) {
          reject(new Error("Missing required fields: subscription_id, country_code, end_date_of_subscription, user_guid"));
          return;
        }

        if (!fileData) {
          reject(new Error("Missing required photo file"));
          return;
        }

        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        const timestamp = Date.now();
        const storagePath = `restoreSubscriptionMigration/${user_guid}_${timestamp}_${fileData.filename}`;

        await bucket.upload(fileData.filepath, {
          destination: storagePath,
          metadata: {
            contentType: fileData.mimeType,
          },
        });

        const photo_link = storagePath;
        fs.unlinkSync(fileData.filepath);

        const migrationData = {
          subscription_id,
          country_code,
          end_date_of_subscription,
          user_guid,
          status: "pending",
          photo_link,
          created_at: Timestamp.now(),
        };

        await admin.firestore()
          .collection("subscription_migration_restoration")
          .add(migrationData);

        resolve({
          code: 200,
          message: "Subscription migration restoration submitted successfully",
          data: {
            subscription_id,
            photo_link,
          },
        });
      } catch (error) {
        if (fileData && fs.existsSync(fileData.filepath)) {
          fs.unlinkSync(fileData.filepath);
        }
        reject(error);
      }
    });

    busboy.end((req as any).rawBody);
  });
}

export async function handleRestoreSubscriptionMigrationNoAuth(
  req: Request
): Promise<{ code: number; message: string; data: { subscription_id: string; photo_link: string } }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let fileData: FileData | null = null;
    const tmpdir = os.tmpdir();

    busboy.on('field', (fieldname: string, val: string) => {
      fields[fieldname] = val;
    });

    busboy.on('file', (fieldname: string, file: any, info: { filename: string; encoding: string; mimeType: string }) => {
      const { filename, mimeType } = info;

      if (!mimeType.startsWith('image/')) {
        reject(new Error("File must be an image"));
        return;
      }

      const filepath = path.join(tmpdir, filename);
      fileData = { filepath, filename, mimeType };

      file.pipe(fs.createWriteStream(filepath));
    });

    busboy.on('finish', async () => {
      try {
        const { subscription_id, country_code, end_date_of_subscription, user_guid } = fields;

        if (!subscription_id || !country_code || !end_date_of_subscription || !user_guid) {
          reject(new Error("Missing required fields: subscription_id, country_code, end_date_of_subscription, user_guid"));
          return;
        }

        if (!fileData) {
          reject(new Error("Missing required photo file"));
          return;
        }

        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        const timestamp = Date.now();
        const storagePath = `restoreSubscriptionMigration/${user_guid}_${timestamp}_${fileData.filename}`;

        await bucket.upload(fileData.filepath, {
          destination: storagePath,
          metadata: {
            contentType: fileData.mimeType,
          },
        });

        const photo_link = storagePath;
        fs.unlinkSync(fileData.filepath);

        const migrationData = {
          subscription_id,
          country_code,
          end_date_of_subscription,
          user_guid,
          status: "pending",
          photo_link,
          created_at: Timestamp.now(),
        };

        await admin.firestore()
          .collection("subscription_migration_restoration")
          .add(migrationData);

        resolve({
          code: 200,
          message: "Subscription migration restoration submitted successfully",
          data: {
            subscription_id,
            photo_link,
          },
        });
      } catch (error) {
        if (fileData && fs.existsSync(fileData.filepath)) {
          fs.unlinkSync(fileData.filepath);
        }
        reject(error);
      }
    });

    busboy.end((req as any).rawBody);
  });
}

