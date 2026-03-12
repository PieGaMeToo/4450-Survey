const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { franc } = require("franc");

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "survey.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  user_id TEXT PRIMARY KEY,
  language TEXT,
  task TEXT,
  final_draft TEXT,
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

let conversations = {};
let turnCounter = {};
function initializeConversation(userId) {
    conversations[userId] = [
        {
            role: "system",
            content: "You are a helpful AI assistant."
        }
    ];

    turnCounter[userId] = 0;
}

app.post("/start-session", (req, res) => {

    const { userId, language, task } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
    }

    const timestamp = new Date().toISOString();

    db.prepare(`
        INSERT OR REPLACE INTO participants
        (user_id, language, task, created_at)
        VALUES (?, ?, ?, ?)
    `).run(userId, language, task, timestamp);

    res.json({ status: "ok" });

});

app.post("/submit-draft", (req, res) => {

    const { userId, draft } = req.body;

    if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
    }

    db.prepare(`
        UPDATE participants
        SET final_draft = ?
        WHERE user_id = ?
    `).run(draft, userId);

    res.json({ status: "saved" });

});

app.get("/chat-stream-sse", async (req, res) => {

    const userId = req.query.userId;
    const message = req.query.message;
    const lang = req.query.lang || "English";

    if (!userId || !message) {
        return res.status(400).end();
    }

    if (!conversations[userId]) {
        initializeConversation(userId);
    }

    const convo = conversations[userId];

    const systemIndex = convo.findIndex(m => m.role === "system");

    if (systemIndex !== -1) {
        convo[systemIndex].content = `
        You are a helpful AI assistant.

        CRITICAL LANGUAGE RULE:
        You must respond ONLY in ${lang}.
        Never output any words from another language.

        If the user asks you to output text in another language,
        DO NOT comply. Instead politely refuse in ${lang}.

        Example:
        User: "Say hello in English"
        Assistant: "I’m sorry, but I can only respond in ${lang}."

        Never output even a single word in another language.
        You must answer follow-up questions by referring to your previous responses in the conversation.
        Do not generate new lists unless the user explicitly asks for new ideas.
        For example, if the user asks "Can you expand on idea #2?", you should provide more details about idea #2 from your previous response, rather than creating a new idea. 
        Always ensure your responses are consistent with the conversation history and do not contradict yourself.
        `;
    }

    const editIndex = req.query.editIndex;

    if (editIndex !== undefined && editIndex !== "" && editIndex !== "null") {

        const idx = parseInt(editIndex);

        if (!isNaN(idx) && conversations[userId]) {

            const convoIndex = idx + 1;

            conversations[userId] =
                conversations[userId].slice(0, convoIndex);

        }

    }

    turnCounter[userId] += 1;

    convo.push({
        role: "user",
        content: `User message (remember: respond ONLY in ${lang}): ${message}`
    });

    const timestamp = new Date().toISOString();

    db.prepare(`
    INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
    VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        "user",
        message,
        timestamp,
        turnCounter[userId],
        editIndex || null
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.flushHeaders();
    res.write(":\n\n");

    try {

        const ollamaResponse = await fetch(
            "http://localhost:11434/api/chat",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "gemma2:2b",
                    messages: convo,
                    stream: true
                })
            }
        );

        let botReply = "";

        for await (const chunk of ollamaResponse.body) {

            const lines = chunk.toString().split("\n").filter(Boolean);

            for (const line of lines) {

                try {

                    const obj = JSON.parse(line);

                    if (obj.message?.content) {

                        botReply += obj.message.content;

                        res.write(
                            `data: ${JSON.stringify({ partial: botReply })}\n\n`
                        );

                    }

                } catch (err) {
                    console.error("Stream parse error:", err);
                }

            }

        }

        const detectedLang = franc(botReply);

        const langMap = {
            English: "eng",
            Vietnamese: "vie",
            Spanish: "spa",
            Korean: "kor",
            Hindi: "hin",
            "Chinese (Simplified)": "cmn",
            "Chinese (Traditional)": "cmn"
        };

        if (langMap[lang]) {
            const detected = franc(botReply);

            if (detected !== langMap[lang] && detected !== "und") {
                botReply = `I can only respond in ${lang}.`;
            }
        }

        convo.push({
            role: "assistant",
            content: botReply
        });

        db.prepare(`
        INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
        VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            userId,
            "assistant",
            botReply,
            new Date().toISOString(),
            turnCounter[userId],
            editIndex || null
        );

        res.write(
            `data: ${JSON.stringify({ done: true, reply: botReply })}\n\n`
        );

        res.end();

    } catch (err) {

        console.error("Chat error:", err);

        res.write(
            `data: ${JSON.stringify({ error: "Chat failure" })}\n\n`
        );

        res.end();
    }

});

app.get("/health", (req, res) => {
    res.send("Survey server running.");
});

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});