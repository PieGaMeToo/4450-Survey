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

// Initialize conversation memory
function initializeConversation(userId) {
    conversations[userId] = [
        {
            role: "system",
            content: "You are a helpful AI assistant.Respond clearly and directly."

        }
    ];
}

// Demographics endpoint
app.post("/demographics", (req, res) => {
    const {
        participant_id,
        native_language,
        english_proficiency,
        years_in_us,
        ai_usage_frequency
    } = req.body;

    if (!participant_id) {
        return res.status(400).json({ error: "Missing participant_id" });
    }

    db.prepare(`
        INSERT OR REPLACE INTO demographics
        (participant_id, native_language, english_proficiency, years_in_us, ai_usage_frequency)
        VALUES (?, ?, ?, ?, ?)
    `).run(
        participant_id,
        native_language,
        english_proficiency,
        years_in_us,
        ai_usage_frequency
    );

    res.json({ status: "saved" });
});

// Survey reflection endpoint
app.post("/survey-response", (req, res) => {
    const {
        participant_id,
        scenario,
        draft_text,
        used_ai_self_report,
        used_ai_behavioral,
        perceived_risk,
        authenticity
    } = req.body;

    if (!participant_id || !scenario) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    db.prepare(`
        INSERT INTO survey_responses
        (participant_id, scenario, draft_text, used_ai_self_report,
         used_ai_behavioral, perceived_risk, authenticity, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        participant_id,
        scenario,
        draft_text,
        used_ai_self_report,
        used_ai_behavioral ? 1 : 0,
        perceived_risk,
        authenticity,
        new Date().toISOString()
    );

    res.json({ status: "saved" });
});

// SSE chat endpoint
// SSE chat endpoint with chunk-count progress
app.post("/chat-stream", (req, res) => {
    const { userId, message } = req.body;
    if (!userId || !message)
        return res.status(400).json({ error: "Missing userId or message" });

    if (!conversations[userId])
        initializeConversation(userId);

    const convo = conversations[userId];
    convo.push({ role: "user", content: message });

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });

    (async () => {
        try {
            const response = await fetch("http://localhost:11434/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "gemma2:2b",
                    messages: convo,
                    stream: true
                })
            });

            let botReply = "";

            response.body.on("data", chunk => {
                const lines = chunk.toString().split("\n").filter(Boolean);

                for (const line of lines) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj.message?.content) {
                            botReply += obj.message.content;

                            res.write(`data: ${JSON.stringify({
                                partial: botReply
                            })}\n\n`);
                        }
                    } catch (err) { }
                }
            });

            response.body.on("end", () => {

                convo.push({ role: "assistant", content: botReply });

                const timestamp = new Date().toISOString();

                // Save to DB
                db.prepare(`
                    INSERT INTO messages (user_id, role, content, timestamp)
                    VALUES (?, ?, ?, ?)
                `).run(userId, "user", message, timestamp);

                db.prepare(`
                    INSERT INTO messages (user_id, role, content, timestamp)
                    VALUES (?, ?, ?, ?)
                `).run(userId, "assistant", botReply, timestamp);

                res.write(`data: ${JSON.stringify({
                    done: true,
                    reply: botReply
                })}\n\n`);

                res.end();
            });

        } catch (err) {
            console.error(err);
            res.end();
        }
    })();
});

// Save final draft
app.post("/save-draft", (req, res) => {
    const { participant_id, scenario, draft_text } = req.body;

    if (!participant_id || !scenario || !draft_text) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        db.prepare(`
            INSERT INTO final_drafts
            (participant_id, scenario, draft_text, timestamp)
            VALUES (?, ?, ?, ?)
        `).run(
            participant_id,
            scenario,
            draft_text,
            new Date().toISOString()
        );

        res.json({ status: "saved" });

    } catch (err) {
        console.error("Draft save error:", err);
        res.status(500).json({ error: "Failed to save draft" });
    }
});


// Health check
app.get("/health", (req, res) => {
    res.send("Survey server is running.");
});

// Start server
app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
