import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { PROJECT_ID, AWS_REGION } from "../config/constants";
import * as crypto from "crypto";

const secretClient = new SecretManagerServiceClient();

export async function getSecret(secretName: string): Promise<string> {
  const name = `projects/${PROJECT_ID}/secrets/${secretName}/versions/latest`;
  const [version] = await secretClient.accessSecretVersion({ name });
  const payload = version.payload?.data;
  
  if (!payload) {
    throw new Error(`Secret ${secretName} not found`);
  }
  
  return payload instanceof Buffer ? payload.toString('utf8') : payload.toString();
}

export async function getSecretSSM(parameterName: string): Promise<string> {
  const access_key_id = await getSecret("aws_access_key_id");
  const secret_access_key = await getSecret("aws_secret_access_key");

  const ssmClient = new SSMClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: access_key_id,
      secretAccessKey: secret_access_key,
    },
  });

  const command = new GetParameterCommand({
    Name: parameterName,
  });

  const response = await ssmClient.send(command);
  return response.Parameter?.Value || "";
}

export function generateHashedFolderName(secret: string, id: string, type?: string): string {
  const hashInput = type ? secret + String(id) + type : secret + String(id);
  return crypto.createHash('sha1').update(hashInput, 'utf8').digest('hex');
}

