import express from 'express';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

// Define paths to credentials and token files
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Load credentials
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const { client_id, client_secret, redirect_uris } = credentials.web;

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

// Initialize Express app
const app = express();
const PORT = 3000;

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send('Authorization code is missing.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Save tokens to file
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.send('<h1>Authorization successful!</h1><p>You can close this window.</p>');
  } catch (error) {
    res.status(500).send('Failed to retrieve access token.');
  }
});

// Serve the frontend
app.use(express.static(path.join(__dirname, 'frontend')));

// Function to refresh the token
async function refreshAccessToken() {
  try {
    // Load the existing token
    if (!fs.existsSync(TOKEN_PATH)) {
      throw new Error('Token file not found. Please complete the consent process again.');
    }

    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    if (!tokens.refresh_token) {
      throw new Error('Refresh token is missing. Consent may be required again.');
    }

    // Set credentials with the existing refresh token
    oauth2Client.setCredentials({ refresh_token: tokens.refresh_token });

    // Refresh the access token
    const { credentials } = await oauth2Client.refreshAccessToken();

    // Save the updated token to the file
    const updatedTokens = { ...tokens, ...credentials }; // Merge new tokens with existing ones
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedTokens, null, 2));

    return { success: true, tokens: updatedTokens };
  } catch (error) {
    // Explicitly cast the error to Error type
    const err = error as Error;
    return { success: false, error: err.message };
  }
}

// API Endpoint to handle token generation
app.post('/generate-token', async (req, res) => {
  const result = await refreshAccessToken();
  if (result.success) {
    res.json({ message: 'Token refreshed successfully!', tokens: result.tokens });
  } else {
    res.status(500).json({ message: 'Failed to refresh token.', error: result.error });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
