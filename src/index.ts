import { gmail_v1, google } from "googleapis";
import axios from "axios";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  WEBHOOK_URL,
  PORT = 3000,
  REFRESH_MAILS_TIME_MS = "60000",
  JSON_SILO_URL,
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !WEBHOOK_URL || !JSON_SILO_URL) {
  console.error("Missing environment variables. Check your .env file.");
  process.exit(1);
}

const log = {
  info: (message: string) => console.log(`[INFO]: ${message}`),
  warn: (message: string) => console.warn(`[WARNING]: ${message}`),
  error: (message: string, error?: unknown) =>
    console.error(`[ERROR]: ${message}`, error),
};

/**
 * Fetches tokens from JSONSilo.
 */
async function fetchToken(): Promise<any> {
  try {
    log.info("Fetching token from JSONSilo...");
    const response = await axios.get(`${JSON_SILO_URL}`);
    return response.data;
  } catch (error) {
    log.error("Failed to fetch token from JSONSilo.", error);
    throw error;
  }
}

/**
 * Saves tokens to JSONSilo.
 */
async function saveToken(token: any): Promise<void> {
  try {
    log.info("Saving token to JSONSilo...");
    await axios.put(`${JSON_SILO_URL}`, token);
    log.info("Token successfully saved to JSONSilo.");
  } catch (error) {
    log.error("Failed to save token to JSONSilo.", error);
    throw error;
  }
}

/**
 * Initializes and returns an authenticated Gmail API client.
 */
async function authorize(): Promise<gmail_v1.Gmail> {
  log.info("Starting Gmail API authorization...");
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  try {
    const token = await fetchToken();
    oAuth2Client.setCredentials(token);

    oAuth2Client.on("tokens", async (tokens) => {
      if (tokens.refresh_token) {
        await saveToken(tokens);
        log.info("Refresh token updated in JSONSilo.");
      }
    });

    await validateToken(oAuth2Client);
  } catch (error) {
    log.error("Token is invalid or missing. Starting authorization process...");
    await startAuthServer(oAuth2Client);
  }

  log.info("Gmail API successfully authorized.");
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

/**
 * Validates the OAuth2 client's token by making a test API request.
 */
async function validateToken(oAuth2Client: any): Promise<void> {
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  await gmail.users.getProfile({ userId: "me" });
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

      await saveToken(tokens);
      log.info("Authorization successful. Tokens saved to JSONSilo.");
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
      const subject =
        headers.find((header) => header.name === "Subject")?.value || "No Subject";
      const from = headers.find((header) => header.name === "From")?.value || "Unknown Sender";

      const bodyPart = msg.data.payload?.parts?.find(
        (part) => part.mimeType === "text/plain" || part.mimeType === "text/html"
      );

      const body = bodyPart?.body?.data
        ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
        : "No Body Content";

      log.info(`Processing email - From: ${from}, Subject: ${subject}`);

      await sendToDiscord({ from, subject, body });

      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      log.info(`Processed and marked email as read: ${subject}`);
    }
  } catch (error) {
    log.error("An error occurred while fetching or processing emails.");
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

/**
 * Main Entry Point
 */
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
