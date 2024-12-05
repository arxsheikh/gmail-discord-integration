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
  const tokenData = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token, // Ensure this is saved
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: tokens.expiry_date,
  };

  try {
    await set(dbRef, tokenData);
    addLog("Token saved to Firebase successfully.");
  } catch (error) {
    addLog(`Error saving token to Firebase`, "error");
    throw error;
  }
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
    access_type: "offline", // Ensure offline access to get refresh_token
    prompt: "consent",      // Force user to consent and resend refresh_token
    scope: SCOPES,
  });

  addLog(`Generated authorization URL: ${authUrl}`);
  return authUrl;
}

async function handleOAuthCallback(code: string) {
  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
  );

  try {
    // Exchange authorization code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      addLog("No refresh token received. Ensure 'prompt: consent' is set in generateAuthUrl.", "warn");
      throw new Error("Missing refresh token. Authorization flow needs to be repeated.");
    }

    // Save tokens to Firebase
    await saveTokenToFirebase(tokens);
    addLog("Authorization successful. Tokens saved to Firebase.");

  } catch (error:any) {
    addLog(`Error in handleOAuthCallback: ${error.message}`, "error");
  }
}



// -------------------- Gmail Functions --------------------


// -------------------- Fetch and Process Emails --------------------
const processedEmails = new Set<string>(); // In-memory storage for processed email IDs

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
      if (processedEmails.has(message.id!)) {
        addLog(`🚫 Skipped ${index + 1}: Email already processed (ID: ${message.id})`);
        skipped++;
        continue; // Skip already processed emails
      }

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

      // Mark email as processed and save its ID
      processedEmails.add(message.id!);
      addLog(`📌 Marked email as processed (ID: ${message.id}).`);

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

    res.send(` <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #e8f5e9; height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; color: #1b5e20;"> <h1 style="font-size: 30px; margin-bottom: 20px; color: #2e7d32;">Welcome to the Email Fetcher Service</h1> <p style="font-size: 18px; margin-bottom: 30px; color: #388e3c;">Authorization successful. Email fetching in progress.</p> <a href="/logview" style="text-decoration: none; color: white; background-color: #2e7d32; padding: 12px 30px; border-radius: 25px; font-size: 16px; font-weight: bold; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); transition: all 0.3s ease;"> See Logs </a> <p style="font-size: 14px; margin-top: 20px; color: #2e7d32;">Stay updated with the latest email activity.</p> </div>
    `);
    
    
  } catch (error) {
    const authUrl = generateAuthUrl();
    res.send(` <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #f8f4ff; height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; color: #4a148c;"> <h1 style="font-size: 30px; margin-bottom: 20px; color: #6a1b9a;">Authorization Required</h1> <p style="font-size: 18px; margin-bottom: 30px; color: #7b1fa2;">To proceed, please authorize Gmail access.</p> <a href="${authUrl}" style="text-decoration: none; color: white; background-color: #6a1b9a; padding: 12px 30px; border-radius: 25px; font-size: 16px; font-weight: bold; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); transition: all 0.3s ease;"> Authorize Now </a> <p style="font-size: 14px; margin-top: 20px; color: #6a1b9a;">This step ensures secure access to Gmail services.</p> </div> `);
    
    
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
    res.redirect("/"); // Redirect to `/` to start email fetching

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

    const updatedTokens = { ...token, ...credentials }; // Merge new access token with existing data
    await saveTokenToFirebase(updatedTokens);

    addLog("Access token refreshed and saved to Firebase.");
    return google.gmail({ version: "v1", auth: oAuth2Client });
  } catch (error) {
    addLog(`❌ Error refreshing access token: ${(error as Error).message}`, "error");
    throw error;
  }
}



// -------------------- Continuous Execution --------------------
async function startContinuousEmailProcessing(): Promise<void> {
  try {
    const gmail = await authorize();
    gmailClient = gmail;

    // Process emails immediately
    await fetchAndProcessEmails(gmail);

    // Schedule token refresh and email processing
    setInterval(async () => {
      try {
        const token = await loadTokenFromFirebase();
        if (token && token.expiry_date) {
          const currentTime = Date.now();
          const timeUntilExpiry = token.expiry_date - currentTime;

          // Refresh only if the token is about to expire in the next 15 minutes
          if (timeUntilExpiry < 15 * 60 * 1000) {
            const activeGmail = await refreshAccessTokenIfNeeded();
            gmailClient = activeGmail;
            addLog("Token refreshed successfully.");
          }
        }

        await fetchAndProcessEmails(gmailClient!);
      } catch (error) {
        addLog("❌ Error in periodic email fetching.", "error");
      }
    }, 45 * 60 * 1000); // Set interval to 45 minutes
  } catch (error) {
    addLog(`❌ Failed to start email processing: ${(error as Error).message}`, "error");
  }
}


// -------------------- Main --------------------
app.listen(PORT, async () => {
  addLog(`Server running on http://localhost:${PORT}`);
  await startContinuousEmailProcessing();
});