// Webhook URL
const WEBHOOK_URL = "https://discord.com/api/webhooks/1312321936285503539/8PoQrvzxcVh9ab7HNRQWVmzdiowi4ZjiSCn6dG63YXwj74eGN_vqGeYk7C9zUfqLs1WS";

// Payload with URL only in `content`
const defaultMessage = {
  content: "Alert: FWOG - Hitting GR - https://www.tradingview.com/chart/FWOGUSDT/RifzEkxn-FWOG/", // URL in content
};

// Send webhook request
const submitButton = document.getElementById("submitButton");
submitButton.addEventListener("click", async () => {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultMessage),
    });

    if (response.ok) {
      console.log("Message sent successfully!");
    } else {
      console.error("Failed to send message. Status:", response.status);
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
});
