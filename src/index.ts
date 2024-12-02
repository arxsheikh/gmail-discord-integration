import { gmail_v1, google } from "googleapis";
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { child, database, get, ref, set } from "./firebase";

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
  const logEntry = `[${level.toUpperCase()}] [${
    new Date().toISOString()
  }]: ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 20) logs.shift(); // Keep only the last 20 logs
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
  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
  );

  const token = await loadTokenFromFirebase();
  if (token) {
    oAuth2Client.setCredentials(token);

    // Automatically refresh token if it has expired
    oAuth2Client.on("tokens", async (newTokens) => {
      if (newTokens.refresh_token) {
        addLog("New refresh token detected. Saving to Firebase...");
      }
      await saveTokenToFirebase({ ...token, ...newTokens });
      addLog("Access token refreshed and saved.");
    });

    // Check and refresh token if needed
    await ensureValidAccessToken(oAuth2Client);

    addLog("Token successfully set to OAuth2 client.");
  } else {
    throw new Error("Unauthorized: No token found.");
  }

  return google.gmail({ version: "v1", auth: oAuth2Client });
}

// Helper to refresh token if needed
async function ensureValidAccessToken(oAuth2Client: any): Promise<void> {
  try {
    const tokenInfo = await oAuth2Client.getAccessToken();
    const expiryDate = tokenInfo.res?.data?.expiry_date;

    if (expiryDate && Date.now() > expiryDate) {
      addLog("Access token expired. Refreshing...");
      const refreshedTokens = await oAuth2Client.refreshAccessToken();
      oAuth2Client.setCredentials(refreshedTokens.credentials);
      await saveTokenToFirebase(refreshedTokens.credentials);
      addLog("Access token refreshed and saved.");
    }
  } catch (error) {
    addLog(
      "Failed to refresh access token. Reauthorization may be needed.",
      "error",
    );
    throw error;
  }
}

// Generates the Google OAuth URL for authorization
function generateAuthUrl(): string {
  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
  );
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  addLog(`Generated authorization URL: ${authUrl}`);
  return authUrl;
}

// Handles the OAuth2 callback to retrieve and save tokens
async function handleOAuthCallback(code: string) {
  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
  );

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
  addLog("📬 Starting to fetch and process unread emails...");

  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: parseInt(MAX_EMAILS_TO_FETCH),
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    addLog(`✅ Total unread emails found: ${messages.length}`);

    if (messages.length === 0) {
      addLog("ℹ️ No unread emails found. Exiting process.");
      return;
    }

    for (const [index, message] of messages.entries()) {
      addLog(`🔍 Processing email ${index + 1} of ${messages.length}...`);

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const subject = headers.find((header) =>
        header.name === "Subject"
      )?.value || "No Subject";
      const from = headers.find((header) => header.name === "From")?.value ||
        "Unknown Sender";

      if (!subject.includes("Alert")) {
        addLog(
          `🚫 Skipping email ${
            index + 1
          } - Subject does not contain "Alert": ${subject}`,
        );
        continue;
      }

      const bodyPart = msg.data.payload?.parts?.find(
        (part) =>
          part.mimeType === "text/plain" || part.mimeType === "text/html",
      );
      const body = bodyPart?.body?.data
        ? Buffer.from(bodyPart.body.data, "base64").toString("utf-8")
        : "No Body Content";

      addLog(
        `📤 Sending email to Discord - From: ${from}, Subject: ${subject}`,
      );
      await sendToDiscord({ from, subject, body });

      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      addLog(`✅ Email processed and marked as read: ${subject}`);
    }

    const currentTime = new Date();
    const refreshTime = new Date(
      currentTime.getTime() + parseInt(REFRESH_MAILS_TIME_MS),
    );

    addLog("🎉 Email processing completed successfully!");
    addLog(
      `⌛ Next email check will be at ${refreshTime.toLocaleTimeString()} (${refreshTime.toLocaleDateString()}). Current time: ${currentTime.toLocaleTimeString()}`,
    );
  } catch (error: any) {
    if (error.response?.status === 401) {
      addLog("Unauthorized error. Attempting to refresh token...", "error");
      const oAuth2Client = new google.auth.OAuth2(
        CLIENT_ID,
        CLIENT_SECRET,
        REDIRECT_URI,
      );
      const refreshedTokens = await oAuth2Client.refreshAccessToken();
      oAuth2Client.setCredentials(refreshedTokens.credentials);
      await saveTokenToFirebase(refreshedTokens.credentials);
      addLog("Access token refreshed and saved.");
    } else {
      addLog(`❌ Error during email fetching: ${error.message}`, "error");
    }
  }
}


async function sendToDiscord(
  emailData: { from: string; subject: string; body: string },
): Promise<void> {
  try {
    const messagePayload = {
      // Place the URL here to force a preview
      content: "https://www.tradingview.com/chart/FWOGUSDT/RifzEkxn-FWOG/",
      embeds: [
        {
          title: emailData.subject,
          description: `${emailData.body}\n\n[Click here to view chart](https://www.tradingview.com/chart/FWOGUSDT/RifzEkxn-FWOG/)`,
          fields: [{ name: "From", value: emailData.from }],
          color: 3066993, // Optional: Set a color for the embed
        },
      ],
    };

    addLog("Sending email to Discord...");
    await axios.post(WEBHOOK_URL!, messagePayload);
  } catch (error) {
    addLog("Failed to send email to Discord.");
    console.error(error);
  }
}

// -------------------- Main Server Setup --------------------
const app = express();

// Routes for Authorization and Logs
app.get("/", async (req, res) => {
  try {
    const gmail = await authorize();
    addLog("Authorization successful. Initializing email fetch process...");

    setInterval(async () => {
      await fetchAndProcessEmails(gmail);
    }, parseInt(REFRESH_MAILS_TIME_MS));

    res.send(
      "<h1>Welcome to the Email Fetcher Service</h1><p>Authorization successful. Email fetching in progress.</p>",
    );
  } catch (error) {
    const authUrl = generateAuthUrl();
    res.send(
      `<h1>Authorization Required</h1><p><a href="${authUrl}">Click here to authorize Gmail Access</a></p>`,
    );
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
    addLog(
      "Gmail API not yet authorized. Visit the /authorize endpoint to authorize.",
      "warn",
    );
  }
});
