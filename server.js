const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { franc } = require("franc");

const app = express();

app.use(express.json());
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        if (
            origin.endsWith(".qualtrics.com") ||
            origin === "https://www.4450survey.org"
        ) {
            return callback(null, true);
        }

        return callback(new Error("Not allowed by CORS"));
    }
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
let abortControllers = {};
function initializeConversation(userId, lang, draft = "") {
    conversations[userId] = [
        { role: "system", content: `You are a helpful AI assistant. Only respond in ${lang}.` },
        { role: "assistant", content: draft }
    ];
    conversations[userId].sentInitial = false;
    console.log(`[AI Init] Responding in language: ${lang}`);
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

    console.log(`[AI Start] Responding in language: ${language}`);

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

    if (!userId || !message) return res.status(400).end();

    // Abort previous fetch if it exists
    if (abortControllers[userId]) {
        abortControllers[userId].abort();
        delete abortControllers[userId];
    }

    if (!conversations[userId]) {
        initializeConversation(userId, lang);
    }

    // Only push the user message once
    conversations[userId].push({ role: "user", content: message });

    // Build convo for AI
    let convoWithLang = [
        { role: "system", content: `You are a helpful AI assistant. You must respond only in ${lang}. Do not switch languages.` },
        ...conversations[userId] // user + assistant messages only
    ];

    const taskPrompt = req.query.taskPrompt || "";

    if (!conversations[userId].sentInitial) {
        convoWithLang.unshift({ role: "user", content: taskPrompt });
        conversations[userId].sentInitial = true;
    }   

    if (!turnCounter[userId]) turnCounter[userId] = 0;
    turnCounter[userId] += 1;

    let editIndex = req.query.editIndex;
    editIndex = (editIndex === "" || editIndex === undefined || editIndex === "null") ? null : parseInt(editIndex);

    if (editIndex !== null && !isNaN(editIndex)) {
        conversations[userId] = conversations[userId].slice(0, editIndex + 1);
    }

    const timestamp = new Date().toISOString();
    db.prepare(`
        INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, "user", message, timestamp, turnCounter[userId], editIndex || null);

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
    res.write("retry: 1000\n\n");

    res.write(`data: ${JSON.stringify({ aiLanguage: lang })}\n\n`);

    const aiContext = conversations[userId]
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join("\n");

    // Send context to frontend
    res.write(`data: ${JSON.stringify({ context: aiContext, type: "context" })}\n\n`);

    const heartbeat = setInterval(() => res.write(":\n\n"), 3000);

    const controller = new AbortController();
    abortControllers[userId] = controller;

    let botReply = "";
    let replySaved = false;

    req.on("close", () => {
        if (!replySaved && botReply.length > 0) {
            try {
                db.prepare(`
                    INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(userId, "assistant", botReply, new Date().toISOString(), turnCounter[userId], editIndex || null);
                console.log("Saved partial AI response");
            } catch (e) {
                console.error("Failed to save partial response", e);
            }
        }
        clearInterval(heartbeat);
        controller.abort();
        delete abortControllers[userId];
    });

    try {
        const timeout = setTimeout(() => controller.abort(), 30000);

        const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gemma2:2b",
                messages: convoWithLang,
                stream: true,
                options: { num_predict: 700, temperature: 0.7, top_k: 40 }
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        for await (const chunk of ollamaResponse.body) {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.done) continue;
                    if (obj.message?.content) {
                        botReply += obj.message.content;
                        res.write(`data: ${JSON.stringify({ partial: botReply })}\n\n`);
                    }
                } catch (err) {
                    console.error("Stream parse error:", err);
                }
            }
        }

        conversations[userId].push({ role: "assistant", content: botReply });
        console.log(`[AI Response] Language: ${lang}`);

        db.prepare(`
            INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, "assistant", botReply, new Date().toISOString(), turnCounter[userId], editIndex || null);

        replySaved = true;

        res.write(`data: ${JSON.stringify({ done: true, reply: botReply })}\n\n`);

    } catch (err) {
        console.error("Chat error:", err);
        res.write(`data: ${JSON.stringify({ error: "Chat failure" })}\n\n`);
    } finally {
        clearInterval(heartbeat);
        delete abortControllers[userId];
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

app.post("/stop-stream", (req, res) => {
    const { userId } = req.body;
    if (userId && abortControllers[userId]) {
        abortControllers[userId].abort(); // abort the AI fetch
        delete abortControllers[userId];
    }
    res.json({ status: "stopped" });
});

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});

