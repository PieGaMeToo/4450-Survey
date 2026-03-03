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
CREATE TABLE IF NOT EXISTS participants (
  participant_id TEXT PRIMARY KEY,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT,
  scenario TEXT,
  role TEXT,
  content TEXT,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT,
  scenario TEXT,
  draft_text TEXT,
  used_ai_self_report TEXT,
  used_ai_behavioral INTEGER,
  perceived_risk INTEGER,
  authenticity INTEGER,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS demographics (
  participant_id TEXT PRIMARY KEY,
  native_language TEXT,
  english_proficiency INTEGER,
  years_in_us INTEGER,
  ai_usage_frequency INTEGER
);

CREATE TABLE IF NOT EXISTS final_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT,
  scenario TEXT,
  draft_text TEXT,
  timestamp TEXT
);
`);

// In-memory conversations: conversations[userId][scenario] = message array

let conversations = {};

// Initialize conversation memory
function initializeConversation(userId, scenario) {
    if (!conversations[userId]) {
        conversations[userId] = {};
    }

    conversations[userId][scenario] = [
        {
            role: "system",
            content: `You are assisting a multilingual student in drafting academic communication for this scenario: ${scenario}.

            You must return ONLY the fully revised draft text.
            ONLY respond in English.

            Do NOT:
            - Add explanations
            - Add commentary
            - Add introductory phrases
            - Add concluding remarks
            - Add labels such as "Here is a revised draft:"
            - Wrap the draft in quotes
            - Refer to the user
            - Explain what you changed

            Your entire response must consist only of the rewritten draft itself.

            If the user provides a draft, rewrite it directly.
            If the user provides instructions, apply them directly to the draft.

            Output nothing except the final revised draft text.`

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
    const { userId, message, scenario, draft } = req.body;
    if (!userId || !message || !scenario) return res.status(400).json({ error: "Missing userId, message, or scenario" });

    if (!conversations[userId] || !conversations[userId][scenario]) initializeConversation(userId, scenario);
    const convo = conversations[userId][scenario];
    convo.push({ role: "user", content: `Draft:\n${draft}\n\nUser request:\n${message}` });

    // Set headers for SSE
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
                body: JSON.stringify({ model: "gemma2:2b", messages: convo, stream: true })
            });

            let botReply = "";
            let chunkCount = 0;
            const MAX_CHUNKS = 20; // approximate max number of chunks for progress calculation

            response.body.on("data", chunk => {
                const lines = chunk.toString().split("\n").filter(Boolean);
                for (const line of lines) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj.message?.content) {
                            botReply += obj.message.content;
                            chunkCount++;

                            // simple progress calculation
                            const progress = Math.min(100, Math.floor((chunkCount / MAX_CHUNKS) * 100));

                            // send partial updates with progress
                            res.write(`data: ${JSON.stringify({ partial: botReply, progress })}\n\n`);
                        }
                    } catch (err) {
                        console.error("Stream parse error:", err);
                    }
                }
            });

            response.body.on("end", () => {
                convo.push({ role: "assistant", content: botReply });
                const timestamp = new Date().toISOString();

                // save messages and final response
                db.prepare(`INSERT INTO messages (participant_id, scenario, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`)
                    .run(userId, scenario, "user", `Draft:\n${draft}\nRequest:\n${message}`, timestamp);
                db.prepare(`INSERT INTO messages (participant_id, scenario, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`)
                    .run(userId, scenario, "assistant", botReply, timestamp);
                db.prepare(`INSERT INTO survey_responses (participant_id, scenario, draft_text, used_ai_self_report, used_ai_behavioral, perceived_risk, authenticity, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(userId, scenario, botReply, null, 1, null, null, timestamp);

                // final 100% progress
                res.write(`data: ${JSON.stringify({ done: true, reply: botReply, progress: 100 })}\n\n`);
                res.end();
            });

        } catch (err) {
            console.error(err);
            res.write(`data: ${JSON.stringify({ error: "Chat failed", progress: 100 })}\n\n`);
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
