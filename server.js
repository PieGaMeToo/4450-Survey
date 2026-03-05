// server.js
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());
app.use(cors());

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// SQLite Setup
const db = new Database(path.join(__dirname, "survey.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  user_id TEXT PRIMARY KEY,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  role TEXT,
  content TEXT,
  timestamp TEXT
);
`);

// Conversation memory
let conversations = {};
function initializeConversation(userId, lang) {
    conversations[userId] = [
        { role: "system", content: `You are a helpful AI assistant. Respond clearly and directly in ${lang}.` }
    ];
}

// SSE chat endpoint (GET)
app.get("/chat-stream-sse", async (req, res) => {
    const userId = req.query.userId;
    const message = req.query.message;
    const lang = req.query.lang || "English";

    if (!userId || !message) {
        return res.status(400).end();
    }

    if (!conversations[userId]) initializeConversation(userId, lang);
    const convo = conversations[userId];
    convo.push({ role: "user", content: message });

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    res.write(":\n\n"); // comment line to keep connection alive

    try {
        const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gemma2:2b",
                messages: convo,
                stream: true
            })
        });

        let botReply = "";

        for await (const chunk of ollamaResponse.body) {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.message?.content) {
                        botReply += obj.message.content;
                        res.write(`data: ${JSON.stringify({ partial: botReply })}\n\n`);
                    }
                } catch (err) {
                    console.error("Stream parse error:", err);
                }
            }
        }

        convo.push({ role: "assistant", content: botReply });

        // Save messages
        const timestamp = new Date().toISOString();
        db.prepare(`INSERT INTO messages (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)`)
            .run(userId, "user", message, timestamp);
        db.prepare(`INSERT INTO messages (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)`)
            .run(userId, "assistant", botReply, timestamp);

        // Final SSE message
        res.write(`data: ${JSON.stringify({ done: true, reply: botReply })}\n\n`);
        res.end();

    } catch (err) {
        console.error("Chat error:", err);
        res.write(`data: ${JSON.stringify({ error: "Chat failure" })}\n\n`);
        res.end();
    }
});

// Other endpoints (demographics, survey-response, save-draft) remain unchanged
// Health check
app.get("/health", (req, res) => res.send("Survey server is running."));

// Start server
app.listen(3000, () => console.log("Server running on http://localhost:3000"));