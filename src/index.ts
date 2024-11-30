import { gmail_v1, google } from "googleapis";
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
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

// -------------------- Logger --------------------
const logs: string[] = []; // In-memory log storage
function addLog(message: string, level: "info" | "warn" | "error" = "info") {
  const logEntry = `[${level.toUpperCase()}] [${new Date().toISOString()}]: ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 100) logs.shift(); // Keep only the last 100 logs
}

// -------------------- Firebase Token Management --------------------
async function saveTokenToFirebase(tokens: any) {
  const dbRef = ref(database, "gmail-token");
  await set(dbRef, tokens);
  addLog("Token saved to Firebase.");
}

async function loadTokenFromFirebase() {
  const dbRef = ref(database);
  const snapshot = await get(child(dbRef, "gmail-token"));
  if (snapshot.exists()) {
    addLog("Token loaded from Firebase.");
    return snapshot.val();
  } else {
    addLog("No token found in Firebase.", "warn");
    return null;
  }
}

// -------------------- Gmail Authorization --------------------
async function authorize(): Promise<gmail_v1.Gmail> {
  addLog("Authorizing Gmail API...");
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const token = await loadTokenFromFirebase();
  if (token) {
    oAuth2Client.setCredentials(token);
    addLog("Token successfully set to OAuth2 client.");
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
  addLog(`Generated authorization URL: ${authUrl}`);
  return authUrl;
}

// Handles the OAuth2 callback to retrieve and save tokens
async function handleOAuthCallback(code: string) {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  
  // Exchange the authorization code for tokens
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Save tokens to Firebase for future use
  await saveTokenToFirebase(tokens);
  addLog("Authorization successful. Tokens saved to Firebase.");

  // Initialize Gmail API client with the authorized OAuth2 client
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // Start fetching emails immediately
  addLog("Starting email fetching process...");
  try {
    await fetchAndProcessEmails(gmail); // Pass the Gmail client to the function
    addLog("Initial email fetching completed.");

    // Schedule periodic email fetching
    setInterval(async () => {
      await fetchAndProcessEmails(gmail);
    }, parseInt(REFRESH_MAILS_TIME_MS));
  } catch (error) {
    addLog("Error during email fetching process after authorization.", "error");
  }
}

// -------------------- Gmail Functions --------------------
async function fetchAndProcessEmails(gmail: gmail_v1.Gmail): Promise<void> {
  addLog("Fetching latest unread emails...");
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: parseInt(MAX_EMAILS_TO_FETCH),
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    addLog(`Number of unread emails found: ${messages.length}`);
    if (messages.length === 0) {
      addLog("No unread emails found.");
      return;
    }

    for (const [index, message] of messages.entries()) {
      addLog(`Processing email ${index + 1} of ${messages.length}...`);
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const subject =
        headers.find((header) => header.name === "Subject")?.value || "No Subject";

      if (!subject.includes("ALERT")) {
        addLog(`Skipping email - Subject does not contain "ALERT": ${subject}`);
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

      addLog(`Sending email - From: ${from}, Subject: ${subject}`);
      await sendToDiscord({ from, subject, body });

      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      addLog(`Email processed and marked as read: ${subject}`);
    }
  } catch (error) {
    addLog("Error during email fetching.", "error");
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
    addLog("Sending email to Discord...");
    await axios.post(WEBHOOK_URL!, messagePayload);
  } catch (error) {
    addLog("Failed to send email to Discord.");
  }
}

// -------------------- Main Server Setup --------------------
const app = express();

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
    addLog("Error during OAuth callback.", "error");
    res.status(500).send("Failed to authorize.");
  }
});

// Serves frontend HTML for viewing logs
app.get("/logview", (req, res) => {
  res.sendFile(__dirname + "/frontend.html"); // Serve the frontend file
});

// Provides logs as JSON
app.get("/logs", (req, res) => {
  res.json(logs); // Return logs as JSON
});

// Start Server
app.listen(PORT, async () => {
  addLog(`Server running on http://localhost:${PORT}`);
  try {
    const gmail = await authorize();

    // Fetch emails immediately
    await fetchAndProcessEmails(gmail);

    // Schedule periodic email fetching
    setInterval(async () => {
      await fetchAndProcessEmails(gmail);
    }, parseInt(REFRESH_MAILS_TIME_MS));
  } catch (error) {
    addLog("Gmail API not yet authorized. Visit the /authorize endpoint to authorize.", "warn");
  }
});
