const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { franc } = require("franc");

const app = express();

app.use(express.json());
app.use(cors({
    origin: [
        "https://cornell.yul1.qualtrics.com",
        "https://www.4450survey.org"
    ]
}));

const db = new Database(path.join(__dirname, "survey.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  user_id TEXT,
  language TEXT,
  task TEXT,
  task_order TEXT,
  final_draft TEXT,
  completed INTEGER DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY(user_id, task_order)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  role TEXT,
  content TEXT,
  timestamp TEXT,
  turn_number INTEGER,
  edit_index INTEGER
);
`);

let conversations = {};
let turnCounter = {};
function initializeConversation(userId) {
    conversations[userId] = [
        {
            role: "system",
            content: `
You are a helpful AI assistant helping a student.
`
        }
    ];

    turnCounter[userId] = 0;
}

function getRefusalMessage(lang) {
    const refusalMap = {
        English: "I can only understand and respond in English.",
        Spanish: "Solo puedo entender y responder en español.",
        Vietnamese: "Tôi chỉ có thể hiểu và trả lời bằng tiếng Việt.",
        Korean: "저는 한국어로만 이해하고 응답할 수 있습니다.",
        Hindi: "मैं केवल हिंदी में समझ और उत्तर दे सकता हूँ।",
        "Chinese (Simplified)": "我只能用中文理解和回答。",
        "Chinese (Traditional)": "我只能用中文理解和回答。"
    };

    return refusalMap[lang] || `I can only understand and respond in ${lang}.`;
}

app.post("/start-session", (req, res) => {
    const { userId, language, task } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const timestamp = new Date().toISOString();

    const existingTasks = db.prepare(`
        SELECT task_order FROM participants WHERE user_id = ?
    `).all(userId);

    if (existingTasks.length >= 2) {
        return res.status(400).json({ error: "Maximum tasks reached" });
    }

    const task_order = existingTasks.length === 0 ? "1" : "2";

    db.prepare(`
        INSERT INTO participants (user_id, language, task, task_order, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(userId, language, task, task_order, timestamp);

    res.json({ status: "ok", task_order });
});


app.post("/submit-draft", (req, res) => {

    let { userId, taskOrder, draft } = req.body;

    if (!draft) {
        draft = "";
    }

    if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
    }

    const wordCount = draft.trim().split(/\s+/).filter(w => w.length > 0).length;

    let finalDraft = draft;

    if (wordCount < 50) {
        finalDraft = "Invalid Response, Less Than 50 Words";
    }

    db.prepare(`
        UPDATE participants
        SET final_draft = ?, completed = 1
        WHERE user_id = ? AND task_order = ?
    `).run(finalDraft, userId, taskOrder);

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
            Only respond in ${lang}.
            If the user speaks in a different language, politely ask them to switch to ${lang} or let them know you can only understand ${lang}.

            `;
    }

    let editIndex = req.query.editIndex;

    if (editIndex === "" || editIndex === undefined || editIndex === "null") {
        editIndex = null;
    } else {
        editIndex = parseInt(editIndex);
    }

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
        content: message
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

    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(":\n\n");
    }, 3000);

    res.write("retry: 1000\n\n");

    try {

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s

        const ollamaResponse = await fetch(
            "http://localhost:11434/api/chat",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "gemma2:2b",
                    messages: convo,
                    stream: true,
                    options: {
                        num_predict: 400, // Max characters in response
                        temperature: 0.7,
                        top_k: 40
                    }
                }),
                signal: controller.signal
            }
        );

        clearTimeout(timeout);

        let botReply = "";
        let replySaved = false;

        req.on("close", () => {
            if (!replySaved && botReply.length > 0) {
                try {
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
                    console.log("Saved partial AI response");
                } catch (e) {
                    console.error("Failed to save partial response", e);
                }
            }
        });

        for await (const chunk of ollamaResponse.body) {
            const lines = chunk.toString().split("\n").filter(Boolean);

            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);

                    if (obj.done) {
                        continue;
                    }

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
                const fallbackMap = {
                    English: "I can only respond in English.",
                    Spanish: "Solo puedo responder en español.",
                    Vietnamese: "Tôi chỉ có thể trả lời bằng tiếng Việt.",
                    Korean: "저는 한국어로만 응답할 수 있습니다.",
                    Hindi: "मैं केवल हिंदी में उत्तर दे सकता हूँ।",
                    "Chinese (Simplified)": "我只能用中文回答。",
                    "Chinese (Traditional)": "我只能用中文回答。"
                };

                botReply = fallbackMap[lang] || `I can only respond in ${lang}.`;
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
        replySaved = true;

        res.write(
            `data: ${JSON.stringify({ done: true, reply: botReply })}\n\n`
        );
        clearInterval(heartbeat);
        res.end();

    } catch (err) {

        console.error("Chat error:", err);

        res.write(
            `data: ${JSON.stringify({ error: "Chat failure" })}\n\n`
        );
        clearInterval(heartbeat);
        res.end();
    }

});

app.get("/task-status", (req, res) => {

    const userId = req.query.userId;

    if (!userId) {
        return res.json({ completedTasks: 0 });
    }

    const row = db.prepare(`
        SELECT COUNT(*) as count
        FROM participants
        WHERE user_id = ? AND completed = 1
    `).get(userId);

    res.json({
        completedTasks: row.count
    });

});


app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
    res.send("Survey server running.");
});

// Pre-warm Ollama model on server startup
fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        model: "gemma2:2b",
        messages: [{ role: "user", content: "hi" }]
    })
}).catch(err => {
    console.error("Prewarm failed:", err);
});

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});

