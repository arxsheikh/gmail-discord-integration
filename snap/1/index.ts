import { gmail_v1, google } from "googleapis";
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { Server } from "socket.io";
import http from "http";
import { database, ref, set, get, child } from "./firebase";

// Load environment variables
dotenv.config();

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  WEBHOOK_URL,
  PORT = 3000,
  REFRESH_MAILS_TIME_MS = "60000",
  MAX_EMAILS_TO_FETCH = "10",
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI || !WEBHOOK_URL) {
  console.error("Missing environment variables. Check your .env file.");
  process.exit(1);
}

// -------------------- Logger with Socket.io --------------------
let io: Server | null = null;
const log = {
  info: (message: string) => {
    const logData = { level: "info", message: `[INFO]: ${message}` };
    console.log(logData.message);
    if (io) io.emit("log", logData);
  },
  warn: (message: string) => {
    const logData = { level: "warn", message: `[WARNING]: ${message}` };
    console.warn(logData.message);
    if (io) io.emit("log", logData);
  },
  error: (message: string, error?: unknown) => {
    const logData = { level: "error", message: `[ERROR]: ${message} ${error || ""}` };
    console.error(logData.message);
    if (io) io.emit("log", logData);
  },
};

// -------------------- Firebase Token Management --------------------
async function saveTokenToFirebase(tokens: any) {
  const dbRef = ref(database, "gmail-token");
  await set(dbRef, tokens);
  log.info("Token saved to Firebase.");
}

async function loadTokenFromFirebase() {
  const dbRef = ref(database);
  const snapshot = await get(child(dbRef, "gmail-token"));
  if (snapshot.exists()) {
    log.info("Token loaded from Firebase.");
    return snapshot.val();
  } else {
    log.warn("No token found in Firebase.");
    return null;
  }
}

// -------------------- Gmail Authorization --------------------
async function authorize(): Promise<gmail_v1.Gmail> {
  log.info("Authorizing Gmail API...");
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const token = await loadTokenFromFirebase();
  if (token) {
    oAuth2Client.setCredentials(token);
    log.info("Token successfully set to OAuth2 client.");
  } else {
    throw new Error("Unauthorized: No token found.");
  }

  return google.gmail({ version: "v1", auth: oAuth2Client });
}

// Generates the Google OAuth URL for authorization
function generateAuthUrl(): string {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  log.info(`Generated authorization URL: ${authUrl}`);
  return authUrl;
}

// Handles the OAuth2 callback to retrieve and save tokens
async function handleOAuthCallback(code: string) {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  await saveTokenToFirebase(tokens);
  log.info("Authorization successful. Tokens saved to Firebase.");
}

// -------------------- Gmail Functions --------------------
async function fetchAndProcessEmails(gmail: gmail_v1.Gmail): Promise<void> {
  log.info("Fetching latest unread emails...");
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: parseInt(MAX_EMAILS_TO_FETCH),
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    log.info(`Number of unread emails found: ${messages.length}`);
    if (messages.length === 0) {
      log.info("No unread emails found.");
      return;
    }

    for (const [index, message] of messages.entries()) {
      log.info(`Processing email ${index + 1} of ${messages.length}...`);
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const subject =
        headers.find((header) => header.name === "Subject")?.value || "No Subject";

      if (!subject.includes("ALERT")) {
        log.info(`Skipping email - Subject does not contain "ALERT": ${subject}`);
        continue;
      }

      const from =
        headers.find((header) => header.name === "From")?.value || "Unknown Sender";
      const bodyPart = msg.data.payload?.parts?.find(
        (part) => part.mimeType === "text/plain" || part.mimeType === "text/html"
      );
      const body = bodyPart?.body?.data
        ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
        : "No Body Content";

      log.info(`Sending email - From: ${from}, Subject: ${subject}`);
      await sendToDiscord({ from, subject, body });

      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      log.info(`Email processed and marked as read: ${subject}`);
    }
  } catch (error) {
    log.error("Error during email fetching.", error);
  }
}

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
    log.info("Sending email to Discord...");
    await axios.post(WEBHOOK_URL!, messagePayload);
  } catch (error) {
    log.error("Failed to send email to Discord.", error);
  }
}

// -------------------- Main Server Setup --------------------
const app = express();
const server = http.createServer(app);
io = new Server(server);

// Routes for Authorization and Logs
app.get("/", async (req, res) => {
  try {
    await authorize();
    res.send("<h1>Welcome to the Email Fetcher Service</h1><p>Authorization successful. Gmail API ready to use.</p>");
  } catch (error) {
    const authUrl = generateAuthUrl();
    res.send(`<h1>Authorization Required</h1><p><a href="${authUrl}">Click here to authorize Gmail Access</a></p>`);
  }
});

app.get("/authorize", (req, res) => {
  const authUrl = generateAuthUrl();
  res.send(`<h1>Authorize Gmail Access</h1><p><a href="${authUrl}">Click here to authorize</a></p>`);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Authorization code not provided.");
    return;
  }

  try {
    await handleOAuthCallback(code);
    res.send("Authorization successful. You can close this window.");
  } catch (error) {
    log.error("Error during OAuth callback.", error);
    res.status(500).send("Failed to authorize.");
  }
});

app.get("/logs", (req, res) => {
  res.sendFile(__dirname + "/frontend.html"); // Serve the frontend file
});

// Socket.io for real-time logs
io.on("connection", (socket) => {
  log.info("A client connected to the log stream.");
  socket.on("disconnect", () => log.info("A client disconnected from the log stream."));
});

// Start Server
server.listen(PORT, async () => {
  log.info(`Server running on http://localhost:${PORT}`);
  try {
    const gmail = await authorize();

    // Fetch emails immediately
    await fetchAndProcessEmails(gmail);

    // Schedule periodic email fetching
    setInterval(async () => {
      await fetchAndProcessEmails(gmail);
    }, parseInt(REFRESH_MAILS_TIME_MS));
  } catch (error) {
    log.warn("Gmail API not yet authorized. Visit the /authorize endpoint to authorize.");
  }
});
