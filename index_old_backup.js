const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { Timestamp } = require("firebase-admin/firestore");
const { validateRequestAuthentication } = require("./authentication");
const Busboy = require("busboy");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const crypto = require("crypto");

// Initialize Firebase Admin SDK
admin.initializeApp();

// Initialize Secret Manager client
const secretClient = new SecretManagerServiceClient();

// Config
const region = "europe-west2";
const projectId = "1008654973131";
/**
 * Helper function to get secret from Google Secret Manager
 */
async function getSecret(secretName) {
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
    const [version] = await secretClient.accessSecretVersion({ name });
    const payload = version.payload.data;
    // Handle both Buffer and string types
    return payload instanceof Buffer ? payload.toString('utf8') : payload.toString();
}

/**
 * Helper function to get secret from AWS SSM Parameter Store
 * (Same method as upload_bulk_pdf_v1.py)
 */
async function getSecretSSM(parameterName) {
    // Get AWS credentials from Secret Manager first
    const access_key_id = await getSecret("aws_access_key_id");
    const secret_access_key = await getSecret("aws_secret_access_key");

    // Create SSM client (same region as Python script: eu-west-1)
    const ssmClient = new SSMClient({
        region: 'eu-west-1',
        credentials: {
            accessKeyId: access_key_id,
            secretAccessKey: secret_access_key,
        },
    });

    // Get parameter from SSM
    const command = new GetParameterCommand({
        Name: parameterName,
    });

    const response = await ssmClient.send(command);
    return response.Parameter.Value;
}

/**
 * Egypt Subscription function with authentication
 */
exports.egyptSubscription = functions.region(region).https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        let auth = await validateRequestAuthentication(req, res);
        let user_guid = auth.uid;

        // Only allow PUT method
        if (req.method !== 'POST') {
            res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
            return;
        }

        const response = await handleSubscription(req, user_guid);
        res.status(200).json(response);
    } catch (error) {
        functions.logger.error(error);
        // Only send response if headers haven't been sent yet
        // (validateRequestAuthentication may have already sent a response)
        if (!res.headersSent) {
            res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
        }
    }
});

/**
 * Egypt Subscription function without authentication
 */
exports.egyptSubscriptionNoAuth = functions.region(region).https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // Only allow POST method
        if (req.method !== 'POST') {
            res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
            return;
        }

        const response = await handleSubscriptionNoAuth(req);
        res.status(200).json(response);
    } catch (error) {
        functions.logger.error(error);
        res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
    }
});

/**
 * Restore Subscription Migration function with authentication
 */
exports.restoreSubscriptionMigration = functions.region(region).https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        let auth = await validateRequestAuthentication(req, res);
        let user_guid = auth.uid;

        // Only allow POST method
        if (req.method !== 'POST') {
            res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
            return;
        }

        const response = await handleRestoreSubscriptionMigration(req, user_guid);
        res.status(200).json(response);
    } catch (error) {
        functions.logger.error(error);
        // Only send response if headers haven't been sent yet
        // (validateRequestAuthentication may have already sent a response)
        if (!res.headersSent) {
            res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
        }
    }
});

/**
 * Restore Subscription Migration function without authentication
 */
exports.restoreSubscriptionMigrationNoAuth = functions.region(region).https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // Only allow POST method
        if (req.method !== 'POST') {
            res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
            return;
        }

        const response = await handleRestoreSubscriptionMigrationNoAuth(req);
        res.status(200).json(response);
    } catch (error) {
        functions.logger.error(error);
        res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
    }
});

/**
 * Handle subscription with authentication
 */
async function handleSubscription(req, authenticatedUserGuid) {
    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        const fields = {};
        let fileData = null;
        const tmpdir = os.tmpdir();

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, info) => {
            const { filename, encoding, mimeType } = info;
            
            // Validate that it's an image
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
                // Validate required fields
                const { subscription_id, amount_paid, payment_method, duration, account_sent_to, phone_number_sent_from, notes } = fields;
                const user_guid = authenticatedUserGuid;

                if (!subscription_id || !amount_paid || !payment_method || !duration || !account_sent_to || !user_guid) {
                    reject(new Error("Missing required fields: subscription_id, amount_paid, payment_method, duration, account_sent_to, user_guid"));
                    return;
                }

                if (!fileData) {
                    reject(new Error("Missing required photo file"));
                    return;
                }

                // Upload image to Firebase Storage
                const bucket = admin.storage().bucket("mantooq-images-p");
                const timestamp = Date.now();
                const storagePath = `subscriptions/${user_guid}_${timestamp}_${fileData.filename}`;
                
                await bucket.upload(fileData.filepath, {
                    destination: storagePath,
                    metadata: {
                        contentType: fileData.mimeType,
                    },
                });

                // Store the storage path (not public)
                const photo_link = storagePath;

                // Clean up temp file
                fs.unlinkSync(fileData.filepath);

                // Create document in Firestore
                const subscriptionData = {
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

                // Add optional fields if they exist
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
                // Clean up temp file if it exists
                if (fileData && fs.existsSync(fileData.filepath)) {
                    fs.unlinkSync(fileData.filepath);
                }
                reject(error);
            }
        });

        busboy.end(req.rawBody);
    });
}

/**
 * Handle restore subscription migration with authentication
 */
async function handleRestoreSubscriptionMigration(req, authenticatedUserGuid) {
    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        const fields = {};
        let fileData = null;
        const tmpdir = os.tmpdir();

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, info) => {
            const { filename, encoding, mimeType } = info;
            
            // Validate that it's an image
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
                // Validate required fields
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

                // Upload image to Firebase Storage
                const bucket = admin.storage().bucket("mantooq-images-p");
                const timestamp = Date.now();
                const storagePath = `restoreSubscriptionMigration/${user_guid}_${timestamp}_${fileData.filename}`;
                
                await bucket.upload(fileData.filepath, {
                    destination: storagePath,
                    metadata: {
                        contentType: fileData.mimeType,
                    },
                });

                // Store the storage path (not public)
                const photo_link = storagePath;

                // Clean up temp file
                fs.unlinkSync(fileData.filepath);

                // Create document in Firestore
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
                // Clean up temp file if it exists
                if (fileData && fs.existsSync(fileData.filepath)) {
                    fs.unlinkSync(fileData.filepath);
                }
                reject(error);
            }
        });

        busboy.end(req.rawBody);
    });
}

/**
 * Handle restore subscription migration without authentication
 */
async function handleRestoreSubscriptionMigrationNoAuth(req) {
    return new Promise((resolve, reject) => {
        const busboy = Busboy({ headers: req.headers });
        const fields = {};
        let fileData = null;
        const tmpdir = os.tmpdir();

        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        busboy.on('file', (fieldname, file, info) => {
            const { filename, encoding, mimeType } = info;
            
            // Validate that it's an image
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
                // Validate required fields
                const { subscription_id, country_code, end_date_of_subscription, user_guid } = fields;

                if (!subscription_id || !country_code || !end_date_of_subscription || !user_guid) {
                    reject(new Error("Missing required fields: subscription_id, country_code, end_date_of_subscription, user_guid"));
                    return;
                }

                if (!fileData) {
                    reject(new Error("Missing required photo file"));
                    return;
                }

                // Upload image to Firebase Storage
                const bucket = admin.storage().bucket("mantooq-images-p");
                const timestamp = Date.now();
                const storagePath = `restoreSubscriptionMigration/${user_guid}_${timestamp}_${fileData.filename}`;
                
                await bucket.upload(fileData.filepath, {
                    destination: storagePath,
                    metadata: {
                        contentType: fileData.mimeType,
                    },
                });

                // Store the storage path (not public)
                const photo_link = storagePath;

                // Clean up temp file
                fs.unlinkSync(fileData.filepath);

                // Create document in Firestore
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
                // Clean up temp file if it exists
                if (fileData && fs.existsSync(fileData.filepath)) {
                    fs.unlinkSync(fileData.filepath);
                }
                reject(error);
            }
        });

        busboy.end(req.rawBody);
    });
}

/**
 * Admin function to generate S3 presigned URL for upload
 * Requires admin authentication
 */
exports.admin_upload_to_S3 = functions.region(region).https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        // Validate admin authentication
        let auth = await validateRequestAuthentication(req, res);
        let user_guid = auth.uid;

        // Only allow POST method
        if (req.method !== 'POST') {
            res.status(405).json({ code: 405, message: "Method not allowed. Use POST." });
            return;
        }

        // Check if user is in users_adminv2 collection
        const adminDoc = await admin.firestore()
            .collection("users_adminv2")
            .doc(user_guid)
            .get();

        if (!adminDoc.exists) {
            res.status(403).json({ 
                code: 403, 
                message: "Unauthorized: User is not an admin" 
            });
            return;
        }

        // Get S3 details from request body
        const { bucket_name, region: s3_region, file_key, content_type, type, id } = req.body;

        // Special handling for books_database type - only requires type parameter
        if (type === "books_database") {
            const bunny_key = await getSecret("bunny_book_database_API");
            res.status(200).json({
                code: 200,
                message: "Bunny key retrieved successfully",
                data: {
                    bunny_key: bunny_key,
                },
            });
            return;
        }

        // Validate required fields for other types
        if (!bucket_name || !s3_region) {
            res.status(400).json({ 
                code: 400, 
                message: "Missing required fields: bucket_name, region" 
            });
            return;
        }

        // Either file_key must be provided, or both type and id must be provided
        let final_file_key = file_key;
        
        if (!file_key) {
            if (!type || !id) {
                res.status(400).json({ 
                    code: 400, 
                    message: "Either file_key must be provided, or both type and id must be provided" 
                });
                return;
            }

            // Validate type
            if (type !== "pdf" && type !== "image") {
                res.status(400).json({ 
                    code: 400, 
                    message: "Invalid type. Currently only 'pdf' and 'image' are supported" 
                });
                return;
            }

            // Generate file_key based on type
            if (type === "pdf") {
                // Generate file_key using the same method as upload_bulk_pdf_v1.py
                // Pattern: {id}/{hashed_folder_name}/1.pdf
                // Hash: SHA1(secret + id + type)
                const secret = await getSecretSSM("mp3-book-seed");
                const hashInput = secret + String(id) + type;
                const hashedFolderName = crypto.createHash('sha1').update(hashInput, 'utf8').digest('hex');
                final_file_key = `${id}/${hashedFolderName}/1.pdf`;
            } else if (type === "image") {
                // Generate file_key using the same method as upload_images.py
                // Pattern: images/{id}/{hashed_folder_name}/{id}.webp
                // Hash: SHA1(secret + id) - note: no type in hash for images
                const secret = await getSecretSSM("book-picture-seed");
                const hashInput = secret + String(id);
                const hashedFolderName = crypto.createHash('sha1').update(hashInput, 'utf8').digest('hex');
                final_file_key = `images/${id}/${hashedFolderName}/${id}.webp`;
            }
        }

        // Fetch AWS credentials from Secret Manager
        const access_key_id = await getSecret("aws_access_key_id");
        const secret_access_key = await getSecret("aws_secret_access_key");

        // Create S3 client
        const s3Client = new S3Client({
            region: s3_region,
            credentials: {
                accessKeyId: access_key_id,
                secretAccessKey: secret_access_key,
            },
        });

        // Create PutObject command
        const command = new PutObjectCommand({
            Bucket: bucket_name,
            Key: final_file_key,
            ContentType: content_type || 'application/octet-stream',
        });

        // Generate presigned URL (valid for 1 hour by default)
        const expiresIn = 3600; // 1 hour in seconds
        const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });

        // Prepare response data
        const responseData = {
            presigned_url: presignedUrl,
            bucket_name,
            file_key: final_file_key,
            expires_in: expiresIn,
        };

        // If type is pdf, fetch and include bunny_key
        if (type === "pdf") {
            const bunny_key = await getSecret("bunny_api_pdf");
            responseData.bunny_key = bunny_key;
        }

        res.status(200).json({
            code: 200,
            message: "Presigned URL generated successfully",
            data: responseData,
        });
    } catch (error) {
        functions.logger.error(error);
        // Only send response if headers haven't been sent yet
        // (validateRequestAuthentication may have already sent a response)
        if (!res.headersSent) {
            res.status(500).json({ code: 500, message: error.message || "Unexpected error" });
        }
    }
});
