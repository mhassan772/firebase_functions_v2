import { Request } from "express";
import Busboy from "busboy";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { admin } from "../config/admin";
import { Timestamp } from "firebase-admin/firestore";
import { STORAGE_BUCKET } from "../config/constants";
import { FileData } from "../types";

export async function handleSubscription(
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
        const {
          subscription_id,
          amount_paid,
          payment_method,
          duration,
          account_sent_to,
          phone_number_sent_from,
          notes
        } = fields;
        const user_guid = authenticatedUserGuid;

        if (!subscription_id || !amount_paid || !payment_method || !duration || !account_sent_to || !user_guid) {
          reject(new Error("Missing required fields: subscription_id, amount_paid, payment_method, duration, account_sent_to, user_guid"));
          return;
        }

        if (!fileData) {
          reject(new Error("Missing required photo file"));
          return;
        }

        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        const timestamp = Date.now();
        const storagePath = `subscriptions/${user_guid}_${timestamp}_${fileData.filename}`;

        await bucket.upload(fileData.filepath, {
          destination: storagePath,
          metadata: {
            contentType: fileData.mimeType,
          },
        });

        const photo_link = storagePath;
        fs.unlinkSync(fileData.filepath);

        const subscriptionData: any = {
          subscription_id,
          user_guid,
          amount_paid: parseFloat(amount_paid),
          payment_method,
          duration,
          account_sent_to,
          status: "pending",
          photo_link,
          created_at: Timestamp.now(),
        };

        if (phone_number_sent_from) {
          subscriptionData.phone_number_sent_from = phone_number_sent_from;
        }
        if (notes) {
          subscriptionData.notes = notes;
        }

        await admin.firestore()
          .collection("subscriptions_to_be_approved")
          .add(subscriptionData);

        resolve({
          code: 200,
          message: "Subscription submitted successfully for approval",
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

export async function handleSubscriptionNoAuth(req: Request): Promise<{ code: number; message: string; data: { subscription_id: string; photo_link: string } }> {
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
        const {
          subscription_id,
          amount_paid,
          payment_method,
          duration,
          account_sent_to,
          phone_number_sent_from,
          notes,
          user_guid
        } = fields;

        if (!subscription_id || !amount_paid || !payment_method || !duration || !account_sent_to || !user_guid) {
          reject(new Error("Missing required fields: subscription_id, amount_paid, payment_method, duration, account_sent_to, user_guid"));
          return;
        }

        if (!fileData) {
          reject(new Error("Missing required photo file"));
          return;
        }

        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        const timestamp = Date.now();
        const storagePath = `subscriptions/${user_guid}_${timestamp}_${fileData.filename}`;

        await bucket.upload(fileData.filepath, {
          destination: storagePath,
          metadata: {
            contentType: fileData.mimeType,
          },
        });

        const photo_link = storagePath;
        fs.unlinkSync(fileData.filepath);

        const subscriptionData: any = {
          subscription_id,
          user_guid,
          amount_paid: parseFloat(amount_paid),
          payment_method,
          duration,
          account_sent_to,
          status: "pending",
          photo_link,
          created_at: Timestamp.now(),
        };

        if (phone_number_sent_from) {
          subscriptionData.phone_number_sent_from = phone_number_sent_from;
        }
        if (notes) {
          subscriptionData.notes = notes;
        }

        await admin.firestore()
          .collection("subscriptions_to_be_approved")
          .add(subscriptionData);

        resolve({
          code: 200,
          message: "Subscription submitted successfully for approval",
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

