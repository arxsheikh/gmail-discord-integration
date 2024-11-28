import { gmail_v1, google } from "googleapis";
import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";

// -------------------- Configuration --------------------
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = path.resolve(__dirname, "token.json");
const CREDENTIALS_PATH = path.resolve(__dirname, "credentials.json");
const PORT = 3000;
const WEBHOOK_URL = "https://discord.com/api/webhooks/YOUR_WEBHOOK_URL"; // Replace with your Discord webhook URL
const REFRESH_MAILS_TIME_MS = 60000; // Refresh interval in milliseconds (e.g., 60000ms = 1 minute)

// -------------------- Logger --------------------
const log = {
  info: (message: string) => console.log(`[INFO]: ${message}`),
  warn: (message: string) => console.warn(`[WARNING]: ${message}`),
  error: (message: string) => console.error(`[ERROR]: ${message}`),
};

// -------------------- Authorization --------------------

/**
 * Initializes and returns an authenticated Gmail API client.
 */
async function authorize(): Promise<gmail_v1.Gmail> {
  log.info("Starting Gmail API authorization...");
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = credentials.web;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, `https://gmail-discord-integration-arxsheikh-arxsheikhs-projects.vercel.app/oauth2callback`);

  if (fs.existsSync(TOKEN_PATH)) {
    log.info("Using existing token for Gmail API authentication...");
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oAuth2Client.setCredentials(token);

    oAuth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        log.info("Refresh token updated and saved.");
      }
    });
  } else {
    log.warn("No token file found. Starting authorization process...");
    await startAuthServer(oAuth2Client);

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oAuth2Client.setCredentials(token);

    oAuth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        log.info("Refresh token updated and saved.");
      }
    });
  }

  log.info("Gmail API successfully authorized.");
  return google.gmail({ version: "v1", auth: oAuth2Client });
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

    log.info(`Authorization server running on http://localhost:${PORT}`);
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Google Authorization</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            button { font-size: 18px; padding: 10px 20px; cursor: pointer; }
          </style>
        </head>
        <body>
          <h1>Authorize Gmail Access</h1>
          <p>Click the button below to authorize this app to access your Gmail account.</p>
          <button onclick="window.location.href='${authUrl}'">Authorize</button>
        </body>
      </html>
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

      const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
      log.info("Fetching emails immediately after authorization...");
      await fetchAndProcessEmails(gmail);

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Authorization Successful</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            </style>
          </head>
          <body>
            <h1>Authorization Successful!</h1>
            <p>Your account has been authorized. You can close this window now.</p>
          </body>
        </html>
      `);
    } catch (error) {
      log.error("Failed to exchange authorization code.");
      res.status(500).send("Failed to retrieve access token.");
    }
  });

  app.listen(PORT, () => log.info(`Authorization server running on http://localhost:${PORT}`));
}

// -------------------- Email Processing --------------------

/**
 * Fetches and processes unread emails.
 */
async function fetchAndProcessEmails(gmail: gmail_v1.Gmail): Promise<void> {
  log.info("Fetching latest unread emails...");
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 10,
    q: "is:unread",
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) {
    log.info("No unread emails found.");
    return;
  }

  for (const message of messages) {
    const msg = await gmail.users.messages.get({ userId: "me", id: message.id!, format: "full" });
    const headers = msg.data.payload?.headers || [];
    const subject = headers.find((header) => header.name === "Subject")?.value || "No Subject";
    const from = headers.find((header) => header.name === "From")?.value || "Unknown Sender";

    if (!subject.includes("ALERT")) {
      log.info(`Skipping email with subject: ${subject}`);
      continue;
    }

    const bodyPart = msg.data.payload?.parts?.find((part) => part.mimeType === "text/plain");
    const body = bodyPart?.body?.data
      ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
      : "No Body Content";

    await sendToDiscord({ from, subject, body });

    await gmail.users.messages.modify({
      userId: "me",
      id: message.id!,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });

    log.info(`Processed and marked email as read: ${subject}`);
  }

  log.info("Email fetch and process cycle completed. Waiting for next refresh...");
}

/**
 * Sends email content to Discord using a webhook.
 */
async function sendToDiscord(emailData: { from: string; subject: string; body: string }): Promise<void> {
  try {
    const messagePayload = {
      content: null,
      embeds: [
        {
          title: emailData.subject.slice(0, 256),
          description: emailData.body.slice(0, 4096),
          color: 3447003,
          fields: [
            {
              name: "From",
              value: emailData.from.slice(0, 1024),
              inline: false,
            },
          ],
        },
      ],
    };

    await axios.post(WEBHOOK_URL, messagePayload);
    log.info(`Message sent to Discord: ${emailData.subject}`);
  } catch (error: any) {
    log.error(`Failed to send email to Discord: ${error.response?.data || error.message}`);
  }
}

// -------------------- Main Entry Point --------------------

(async function main() {
  try {
    const gmail = await authorize();

    if (fs.existsSync(TOKEN_PATH)) {
      log.info("Fetching emails immediately after authorization...");
      await fetchAndProcessEmails(gmail);
    }

    setInterval(async () => {
      log.info("Waiting for the next scheduled email fetch...");
      await fetchAndProcessEmails(gmail);
    }, REFRESH_MAILS_TIME_MS);
  } catch (error) {
    log.error(`An error occurred: ${error instanceof Error ? error.message : error}`);
  }
})();
