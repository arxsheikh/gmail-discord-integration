import { gmail_v1, google } from "googleapis";
import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// -------------------- Configuration --------------------
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = path.resolve(__dirname, "token.json");
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  WEBHOOK_URL,
  PORT = 3000,
  REFRESH_MAILS_TIME_MS = "60000",
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

  // Attempt to load the token file if it exists
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      oAuth2Client.setCredentials(token);

      // Ensure the refresh token is used to obtain a new access token if necessary
      oAuth2Client.on("tokens", (tokens) => {
        if (tokens.refresh_token) {
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          log.info("Refresh token updated and saved.");
        }
      });

      // Validate token and attempt an API call to ensure it works
      await validateToken(oAuth2Client);
    } catch (error) {
      log.error("Token file is invalid or expired. Reauthorizing...", error);
      await startAuthServer(oAuth2Client);
    }
  } else {
    log.warn("No token file found. Starting authorization process...");
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
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      log.info("Authorization successful. Tokens saved to file.");
      res.send("Authorization successful. You can close this window.");
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
/**
 * Fetches and processes unread emails.
 */
async function fetchAndProcessEmails(gmail: gmail_v1.Gmail): Promise<void> {
  log.info("Fetching latest unread emails...");
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10,
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

      // Limit subject to 50 words
      subject = subject.split(/\s+/).slice(0, 50).join(" ");

      // Skip emails without the word "ALERT" in uppercase in the subject
      if (!subject.includes("ALERT")) {
        log.info(`Skipping email - Subject does not contain "ALERT": ${subject}`);
        continue;
      }

      const from = headers.find((header) => header.name === "From")?.value || "Unknown Sender";

      // Extract the email body (plain text or HTML)
      const bodyPart = msg.data.payload?.parts?.find(
        (part) => part.mimeType === "text/plain" || part.mimeType === "text/html"
      );

      const body = bodyPart?.body?.data
        ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
        : "No Body Content";

      log.info(`Processing email - From: ${from}, Subject: ${subject}`);

      // Send the email data to Discord with the full body
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
    if (error.message.includes("No access, refresh token, API key or refresh handler callback")) {
      log.error("Unable to fetch emails: Missing or invalid credentials.");
    } else {
      log.error("An error occurred while fetching or processing emails.");
    }
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
    await fetchAndProcessEmails(gmail);

    setInterval(async () => {
      await fetchAndProcessEmails(gmail);
    }, parseInt(REFRESH_MAILS_TIME_MS));
  } catch (error) {
    log.error("An error occurred.", error);
  }
})();
