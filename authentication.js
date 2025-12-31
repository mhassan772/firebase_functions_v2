const admin = require("firebase-admin");

/**
 * Validates request authentication by checking the Authorization header
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<Object>} - Authentication result with uid
 */
async function validateRequestAuthentication(req, res) {
    try {
        // Get the Authorization header
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ 
                code: 401, 
                message: "Missing or invalid authorization header. Expected 'Bearer <token>'." 
            });
            throw new Error("Missing or invalid authorization header");
        }

        // Extract the token
        const idToken = authHeader.split('Bearer ')[1];
        
        if (!idToken) {
            res.status(401).json({ 
                code: 401, 
                message: "Missing ID token in authorization header." 
            });
            throw new Error("Missing ID token");
        }

        // Verify the token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        if (!decodedToken.uid) {
            res.status(401).json({ 
                code: 401, 
                message: "Invalid token: missing user ID." 
            });
            throw new Error("Invalid token: missing user ID");
        }

        return {
            uid: decodedToken.uid,
            email: decodedToken.email,
            email_verified: decodedToken.email_verified
        };
        
    } catch (error) {
        console.error('Authentication error:', error);
        
        if (error.code === 'auth/invalid-token') {
            res.status(401).json({ 
                code: 401, 
                message: "Invalid or expired token." 
            });
        } else if (error.code === 'auth/token-expired') {
            res.status(401).json({ 
                code: 401, 
                message: "Token has expired." 
            });
        } else {
            res.status(401).json({ 
                code: 401, 
                message: "Authentication failed: " + error.message 
            });
        }
        
        throw error;
    }
}

module.exports = {
    validateRequestAuthentication
};
