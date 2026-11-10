import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import {
  AUTH_EMAIL_FROM_ADDRESS,
  AUTH_EMAIL_REPLY_TO_ADDRESS,
  AUTH_EMAIL_SECRETS,
  AUTH_EMAIL_SES_REGION,
} from "../../config/constants";
import { RenderedEmail } from "./authEmailTemplates";

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  fromName: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

/**
 * Formats a From header whose display name may be Arabic.
 *
 * SES accepts only ASCII in the header, so a non-ASCII name goes in as a MIME encoded-word.
 */
export function formatFromAddress(name: string, address: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) {
    return `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
  }
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${address}>`;
}

let client: SESv2Client | null = null;

function sesClient(): SESv2Client {
  if (!client) {
    const accessKeyId = process.env[AUTH_EMAIL_SECRETS.sesAccessKeyId];
    const secretAccessKey = process.env[AUTH_EMAIL_SECRETS.sesSecretAccessKey];
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("SES credentials are not available to this function.");
    }
    client = new SESv2Client({
      region: AUTH_EMAIL_SES_REGION,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

/** Sends through Amazon SES with the secrets the function was deployed with. */
export const sesMailer: Mailer = {
  async send(email: OutgoingEmail): Promise<void> {
    await sesClient().send(
      new SendEmailCommand({
        FromEmailAddress: formatFromAddress(email.fromName, AUTH_EMAIL_FROM_ADDRESS),
        Destination: { ToAddresses: [email.to] },
        ReplyToAddresses: [AUTH_EMAIL_REPLY_TO_ADDRESS],
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: email.html, Charset: "UTF-8" },
              Text: { Data: email.text, Charset: "UTF-8" },
            },
          },
        },
      })
    );
  },
};
