import { gmail_v1, google } from "googleapis";
import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { child, database, get, ref, set } from "./firebase";
let gmailClient: gmail_v1.Gmail | null = null;

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

    addLog("Token successfully set to OAuth2 client.");
  } else {
    throw new Error("Unauthorized: No token found.");
  }

  return google.gmail({ version: "v1", auth: oAuth2Client });
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
// Function to refresh the access token and save to Firebase
async function refreshAccessToken(): Promise<void> {
  try {
    const token = await loadTokenFromFirebase();
    if (!token || !token.refresh_token) {
      throw new Error(
        "Refresh token is missing. Consent may be required again.",
      );
    }

    const oAuth2Client = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI,
    );
    oAuth2Client.setCredentials({ refresh_token: token.refresh_token });

    // Refresh the access token
    const { credentials } = await oAuth2Client.refreshAccessToken();

    const updatedTokens = { ...token, ...credentials }; // Merge the new access token with existing data

    // Save the updated token back to Firebase
    await saveTokenToFirebase(updatedTokens);
    addLog("Access token refreshed and saved to Firebase.");
  } catch (error) {
    const err = error as Error;
    addLog(`Error refreshing access token: ${err.message}`, "error");
    throw err; // Re-throw the error if refreshing fails
  }
}

// -------------------- Gmail Functions --------------------


// -------------------- Fetch and Process Emails --------------------
async function fetchAndProcessEmails(gmail: gmail_v1.Gmail): Promise<void> {
  addLog("📬 Fetching unread emails...");

  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: parseInt(MAX_EMAILS_TO_FETCH),
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    addLog(`✅ Found ${messages.length} unread emails.`);

    if (messages.length === 0) {
      addLog("ℹ️ No unread emails.");
      return;
    }

    let skipped = 0,
      processed = 0;

    for (const [index, message] of messages.entries()) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "full",
      });

      const headers = msg.data.payload?.headers || [];
      const subject = headers.find((header) => header.name === "Subject")?.value || "No Subject";

      if (!subject.includes("Alert")) {
        skipped++;
        addLog(`🚫 Skipped ${index + 1}: "${subject}"`);

        // Mark skipped email as read
        await gmail.users.messages.modify({
          userId: "me",
          id: message.id!,
          requestBody: { removeLabelIds: ["UNREAD"] },
        });
        addLog("✅ Skipped email marked as read.");
        continue;
      }

      addLog(`✅ Got: "${subject}"`);
      addLog("📤 Sending to Discord...");
      await sendToDiscord({ subject });
      addLog("✅ Sent!");

      // Mark processed email as read
      await gmail.users.messages.modify({
        userId: "me",
        id: message.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
      addLog("✅ Processed email marked as read.");

      processed++;
    }

    addLog(`🎉 Done: Processed ${processed}, Skipped ${skipped}.`);
  } catch (error: any) {
    if (error.response?.status === 401) {
      addLog("⚠️ Token expired, refreshing...");
      gmailClient = await refreshAccessTokenIfNeeded();
      await fetchAndProcessEmails(gmailClient); // Retry with the refreshed client
    } else {
      addLog(`❌ Error: ${error.message}`, "error");
    }
  }
}




// Discord Notification Function
async function sendToDiscord(emailData: { subject: string }): Promise<void> {
  try {
    const messagePayload = {
      content: `@everyone ${emailData.subject}`,
    };

    await axios.post(WEBHOOK_URL!, messagePayload);
  } catch (error) {
    addLog(`❌ Failed to send message to Discord`, "error");
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


// -------------------- Token Refresh --------------------
async function refreshAccessTokenIfNeeded(): Promise<gmail_v1.Gmail> {
  try {
    const token = await loadTokenFromFirebase();
    if (!token || !token.refresh_token) {
      throw new Error("Refresh token is missing. Consent may be required again.");
    }

    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: token.refresh_token });

    // Refresh the access token
    const { credentials } = await oAuth2Client.refreshAccessToken();

    const updatedTokens = { ...token, ...credentials }; // Merge the new access token with existing data

    // Save the updated token back to Firebase
    await saveTokenToFirebase(updatedTokens);
    addLog("Access token refreshed and saved to Firebase.");

    // Reinitialize Gmail client
    return google.gmail({ version: "v1", auth: oAuth2Client });
  } catch (error) {
    addLog(`❌ Error refreshing access token: ${(error as Error).message}`, "error");
    throw error; // Re-throw error if refresh fails
  }
}



// -------------------- Continuous Execution --------------------
async function startContinuousEmailProcessing(): Promise<void> {
  try {
    const gmail = await authorize();
    gmailClient = gmail;

    // Process emails immediately
    await fetchAndProcessEmails(gmail);

    // Set up periodic execution
    setInterval(async () => {
      try {
        const activeGmail = await refreshAccessTokenIfNeeded();
        await fetchAndProcessEmails(activeGmail);
      } catch (error) {
        addLog("❌ Error in periodic email fetching.", "error");
      }
    }, parseInt(REFRESH_MAILS_TIME_MS));
  } catch (error) {
    addLog(`❌ Failed to start email processing: ${(error as Error).message}`, "error");
  }
}

// -------------------- Main --------------------
app.listen(PORT, async () => {
  addLog(`Server running on http://localhost:${PORT}`);
  await startContinuousEmailProcessing();
});