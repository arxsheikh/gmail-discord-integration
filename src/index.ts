import { gmail_v1, google } from "googleapis";
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { database, ref, set, get, child } from "./firebase";

// Load environment variables
dotenv.config();

// -------------------- Configuration --------------------
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  WEBHOOK_URL,
  PORT = 3000,
  REFRESH_MAILS_TIME_MS = "60000", // Time in milliseconds (default: 60 seconds)
  MAX_EMAILS_TO_FETCH = "10", // Max emails to fetch (default: 10)
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !WEBHOOK_URL) {
  console.error("Missing environment variables. Check your .env file.");
  process.exit(1);
}

// -------------------- Logger --------------------
const log = {
  info: (message: string) => console.log(`[INFO]: ${message}`),
  warn: (message: string) => console.warn(`[WARNING]: ${message}`),
  error: (message: string, error?: unknown) =>
    console.error(`[ERROR]: ${message}`, error),
};

// -------------------- Firebase Token Management --------------------

// Save token to Firebase
async function saveTokenToFirebase(tokens: any) {
  const dbRef = ref(database, "gmail-token"); // Firebase path for the token
  await set(dbRef, tokens);
  log.info("Token saved to Firebase.");
}

// Load token from Firebase
async function loadTokenFromFirebase() {
  const dbRef = ref(database);
  const snapshot = await get(child(dbRef, "gmail-token")); // Firebase path for the token
  if (snapshot.exists()) {
    log.info("Token loaded from Firebase.");
    return snapshot.val();
  } else {
    log.warn("No token found in Firebase.");
    return null;
  }
}

// -------------------- Authorization --------------------

/**
 * Initializes and returns an authenticated Gmail API client.
 */
async function authorize(): Promise<gmail_v1.Gmail> {
  log.info("Starting Gmail API authorization...");
  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const token = await loadTokenFromFirebase();
  if (token) {
    oAuth2Client.setCredentials(token);

    // Save updated tokens automatically (if refresh token changes)
    oAuth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        saveTokenToFirebase(tokens);
      }
    });

    try {
      await validateToken(oAuth2Client);
    } catch (error) {
      log.error("Token validation failed. Reauthorizing...");
      await startAuthServer(oAuth2Client);
    }
  } else {
    log.warn("No token found in Firebase. Starting authorization process...");
    await startAuthServer(oAuth2Client);
  }

  log.info("Gmail API successfully authorized.");
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

/**
 * Validates the OAuth2 client's token by making a test API request.
 */
async function validateToken(oAuth2Client: any): Promise<void> {
  try {
    const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
    await gmail.users.getProfile({ userId: "me" }); // Test API call
    log.info("Token validation successful.");
  } catch (error) {
    throw new Error("Invalid or expired token. Reauthorization required.");
  }
}

/**
 * Starts an Express server to handle OAuth2 authorization.
 */
async function startAuthServer(oAuth2Client: any): Promise<void> {
  const app = express();

  app.get("/", (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });

    log.info(`Generated authorization URL: ${authUrl}`);
    res.send(`
      <h1>Authorize Gmail Access</h1>
      <p><a href="${authUrl}">Click here to authorize</a></p>
    `);
  });

  app.get("/oauth2callback", async (req, res) => {
    const code = req.query.code as string;
  
    if (!code) {
      log.error("Authorization code not provided.");
      res.status(400).send("Authorization code not provided.");
      return;
    }
  
    try {
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      await saveTokenToFirebase(tokens); // Save token to Firebase
      log.info("Authorization successful. Tokens saved to Firebase.");
      res.send("Authorization successful. You can close this window.");
  
      // Start fetching emails immediately after authorization
      log.info("Starting email fetch process...");
      const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  
      // Fetch emails immediately
      await fetchAndProcessEmails(gmail);
  
      // Set up periodic email fetching
      setInterval(async () => {
        try {
          await fetchAndProcessEmails(gmail);
        } catch (error) {
          log.error("Error during periodic email fetching.", error);
        }
      }, parseInt(REFRESH_MAILS_TIME_MS));
  
    } catch (error) {
      log.error("Failed to exchange authorization code for tokens.", error);
      res.status(500).send("Failed to retrieve access token.");
    }
  });
  

  app.listen(PORT, () =>
    log.info(`Authorization server running on http://localhost:${PORT}`)
  );
}

// -------------------- Email Processing --------------------

/**
 * Fetches and processes unread emails.
 */
async function fetchAndProcessEmails(gmail: gmail_v1.Gmail): Promise<void> {
  log.info("Fetching latest unread emails...");
  try {
    const maxEmails = parseInt(MAX_EMAILS_TO_FETCH);
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: maxEmails,
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    log.info(`Number of unread emails found: ${messages.length}`);

    if (messages.length === 0) {
      log.info("No unread emails found.");
      return;
    }

    for (const message of messages) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      let subject =
        headers.find((header) => header.name === "Subject")?.value || "No Subject";

      const from =
        headers.find((header) => header.name === "From")?.value || "Unknown Sender";

      const bodyPart = msg.data.payload?.parts?.find(
        (part) => part.mimeType === "text/plain" || part.mimeType === "text/html"
      );

      const body = bodyPart?.body?.data
        ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
        : "No Body Content";

      // Log for emails being skipped
      if (!subject.includes("ALERT")) {
        log.info(`Skipping email - Subject: ${subject.slice(0, 20)}...`);
        continue; // Skip the email if it doesn't contain "ALERT"
      }

      // Log for emails being processed
      log.info(`Processing email - From: ${from}, Subject: ${subject}`);

      // Send email to Discord
      await sendToDiscord({ from, subject, body });

      // Mark the email as read
      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      log.info(`Processed and marked email as read: ${subject}`);
    }
  } catch (error: any) {
    log.error("An error occurred while fetching emails.", error);
  }
}


/**
 * Sends email content to Discord using a webhook.
 */
async function sendToDiscord(emailData: { from: string; subject: string; body: string }): Promise<void> {
  try {
    const messagePayload = {
      embeds: [
        {
          title: emailData.subject,
          description: emailData.body,
          fields: [{ name: "From", value: emailData.from }],
        },
      ],
    };

    log.info("Sending email data to Discord...");
    await axios.post(WEBHOOK_URL!, messagePayload);
  } catch (error) {
    log.error("Failed to send email to Discord.", error);
  }
}

// -------------------- Main Entry Point --------------------

(async function main() {
  try {
    const gmail = await authorize();

    // If already authorized, start fetching emails immediately
    await fetchAndProcessEmails(gmail);

    // Set up periodic email fetching
    setInterval(async () => {
      try {
        await fetchAndProcessEmails(gmail);
      } catch (error) {
        log.error("Error during periodic email fetching.", error);
      }
    }, parseInt(REFRESH_MAILS_TIME_MS));

  } catch (error) {
    log.error("An error occurred.", error);
  }
})();
