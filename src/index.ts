import { gmail_v1, google } from "googleapis";
import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// -------------------- Configuration --------------------
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const CREDENTIALS_PATH = path.resolve(__dirname, "credentials.json");
const PORT = 3000;
const WEBHOOK_URL = "https://discord.com/api/webhooks/YOUR_WEBHOOK_URL"; // Replace with your Discord webhook URL
const REFRESH_MAILS_TIME_MS = 60000; // Refresh interval in milliseconds (e.g., 60000ms = 1 minute)

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
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris
  );

  const tokenRecord = await prisma.token.findFirst();

  if (tokenRecord) {
    log.info("Using existing token from database for Gmail API authentication...");
    oAuth2Client.setCredentials({
      access_token: tokenRecord.access_token,
      refresh_token: tokenRecord.refresh_token || undefined,
      scope: tokenRecord.scope || undefined, // Convert null to undefined
      token_type: tokenRecord.token_type || undefined,
      expiry_date: tokenRecord.expiry_date ? Number(tokenRecord.expiry_date) : undefined, // Convert bigint to number
    });
  
    oAuth2Client.on("tokens", async (tokens) => {
      if (tokens.access_token) {
        await prisma.token.upsert({
          where: { id: tokenRecord.id },
          update: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
            token_type: tokens.token_type,
            expiry_date: tokens.expiry_date ? BigInt(tokens.expiry_date) : null, // Convert number to bigint
          },
          create: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
            token_type: tokens.token_type,
            expiry_date: tokens.expiry_date ? BigInt(tokens.expiry_date) : null,
          },
        });
        log.info("Token updated in the database.");
      }
    });
  
  }else {
    log.warn("No token found in the database. Starting authorization process...");
    await startAuthServer(oAuth2Client);
  
    const newToken = await prisma.token.findFirst();
    if (newToken) {
      oAuth2Client.setCredentials({
        access_token: newToken.access_token,
        refresh_token: newToken.refresh_token || undefined, // Convert null to undefined
        scope: newToken.scope || undefined, // Convert null to undefined
        token_type: newToken.token_type || undefined, // Convert null to undefined
        expiry_date: newToken.expiry_date ? Number(newToken.expiry_date) : undefined, // Convert bigint to number
      });
    }
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

    log.info(`Generated authorization URL: ${authUrl}`);
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

    log.info("Authorization callback received.");
    log.info(`Authorization code received: ${code || "None"}`);

    if (!code) {
      log.error("Authorization code not provided.");
      res.status(400).send("Authorization code not provided.");
      return;
    }

    try {
      log.info("Exchanging authorization code for tokens...");
      const { tokens } = await oAuth2Client.getToken(code);
      log.info(`Tokens received: ${JSON.stringify(tokens)}`);
      oAuth2Client.setCredentials(tokens);

      await prisma.token.upsert({
        where: { id: 1 },
        update: {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope,
          token_type: tokens.token_type,
          expiry_date: tokens.expiry_date,
        },
        create: {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope,
          token_type: tokens.token_type,
          expiry_date: tokens.expiry_date,
        },
      });

      log.info("Authorization successful. Tokens saved to database.");

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
      log.error("Failed to exchange authorization code.", error);
      res.status(500).send("Failed to retrieve access token.");
    }
  });

  app.listen(
    PORT,
    () => log.info(`Authorization server running on http://localhost:${PORT}`)
  );
}

// -------------------- Email Processing --------------------
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
      log.info(`Processing email with ID: ${message.id}`);
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const subject =
        headers.find((header) => header.name === "Subject")?.value ||
        "No Subject";
      const from =
        headers.find((header) => header.name === "From")?.value ||
        "Unknown Sender";

      if (!subject.includes("ALERT")) {
        log.info(`Skipping email with subject: ${subject}`);
        continue;
      }

      const bodyPart = msg.data.payload?.parts?.find(
        (part) => part.mimeType === "text/plain"
      );
      const body = bodyPart?.body?.data
        ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
        : "No Body Content";

      log.info(`Email details - From: ${from}, Subject: ${subject}`);
      await sendToDiscord({ from, subject, body });

      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      log.info(`Processed and marked email as read: ${subject}`);
    }
  } catch (error) {
    log.error("Error fetching or processing emails.", error);
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

    log.info("Sending email data to Discord...");
    await axios.post(WEBHOOK_URL, messagePayload);
    log.info(`Message sent to Discord: ${emailData.subject}`);
  } catch (error: any) {
    log.error(
      `Failed to send email to Discord: ${
        error.response?.data || error.message
      }`
    );
  }
}

// -------------------- Main Entry Point --------------------
(async function main() {
  try {
    const gmail = await authorize();

    setInterval(async () => {
      log.info("Waiting for the next scheduled email fetch...");
      await fetchAndProcessEmails(gmail);
    }, REFRESH_MAILS_TIME_MS);
  } catch (error) {
    log.error(`An error occurred: ${error instanceof Error ? error.message : error}`);
  }
})();
