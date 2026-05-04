const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");
const { franc } = require("franc");
const nodejieba = require("nodejieba");

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

function getSessionKey(userId, task, lang) {
    return `${userId}-${task || "unknown"}-${lang || "English"}`;
}

function initializeConversation(sessionKey, lang, draft = "") {
    conversations[sessionKey] = [
        { role: "system", content: `You are a helpful AI assistant. Only respond in ${lang}.` },
        { role: "assistant", content: draft }
    ];
    conversations[sessionKey].sentInitial = false;
    console.log(`[AI Init] Session=${sessionKey} Language=${lang}`);
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

    if (!draft) draft = "";

    if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
    }

    const cleaned = draft.trim();

    let wordCount = 0;

    if (cleaned) {
        const cjkRegex = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
        const latinRegex = /[a-zA-Z]+/g;

        const cjkMatches = cleaned.match(cjkRegex);
        const latinMatches = cleaned.match(latinRegex);

        if (cjkMatches) wordCount += cjkMatches.length;
        if (latinMatches) wordCount += latinMatches.length;
    }

    let finalDraft = draft;

    if (wordCount < 50) {
        finalDraft = "Invalid Response, Less Than 50 Words: " + draft;
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
    const task = req.query.task || "unknown";

    if (!userId || !message) return res.status(400).end();

    const sessionKey = getSessionKey(userId, task, lang);

    if (abortControllers[sessionKey]) {
        abortControllers[sessionKey].abort();
        delete abortControllers[sessionKey];
    }

    if (!conversations[sessionKey]) {
        initializeConversation(sessionKey, lang);
    }

    conversations[sessionKey].push({ role: "user", content: message });

    let convoWithLang = [
        { role: "system", content: `You must respond only in ${lang}. Do not switch languages.` },
        ...conversations[sessionKey]
    ];

    const taskPrompt = req.query.taskPrompt || "";

    if (!conversations[sessionKey].sentInitial) {
        convoWithLang.unshift({ role: "user", content: taskPrompt });
        conversations[sessionKey].sentInitial = true;
    }

    if (!turnCounter[sessionKey]) turnCounter[sessionKey] = 0;
    turnCounter[sessionKey] += 1;

    let editIndex = req.query.editIndex;
    editIndex = (editIndex === "" || editIndex === undefined || editIndex === "null")
        ? null
        : parseInt(editIndex);

    if (editIndex !== null && !isNaN(editIndex)) {
        conversations[sessionKey] = conversations[sessionKey].slice(0, editIndex + 1);
    }

    const timestamp = new Date().toISOString();

    db.prepare(`
        INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, "user", message, timestamp, turnCounter[sessionKey], editIndex || null);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
    res.write("retry: 1000\n\n");
    res.write(`data: ${JSON.stringify({ aiLanguage: lang })}\n\n`);

    const aiContext = conversations[sessionKey]
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join("\n");

    res.write(`data: ${JSON.stringify({ context: aiContext, type: "context" })}\n\n`);

    const heartbeat = setInterval(() => res.write(":\n\n"), 3000);

    const controller = new AbortController();
    abortControllers[sessionKey] = controller;

    let botReply = "";
    let replySaved = false;

    req.on("close", () => {
        if (!replySaved && botReply.length > 0) {
            db.prepare(`
                INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(userId, "assistant", botReply, new Date().toISOString(), turnCounter[sessionKey], editIndex || null);
        }

        clearInterval(heartbeat);
        controller.abort();
        delete abortControllers[sessionKey];
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

        conversations[sessionKey].push({ role: "assistant", content: botReply });

        db.prepare(`
            INSERT INTO messages (user_id, role, content, timestamp, turn_number, edit_index)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, "assistant", botReply, new Date().toISOString(), turnCounter[sessionKey], editIndex || null);

        replySaved = true;

        res.write(`data: ${JSON.stringify({ done: true, reply: botReply })}\n\n`);

    } catch (err) {
        console.error("Chat error:", err);
        res.write(`data: ${JSON.stringify({ error: "Chat failure" })}\n\n`);
    } finally {
        clearInterval(heartbeat);
        delete abortControllers[sessionKey];
        res.end();
    }
});

app.get("/task-status", (req, res) => {

    const userId = req.query.userId;

    if (!userId) return res.json({ completedTasks: 0 });

    const row = db.prepare(`
        SELECT COUNT(*) as count
        FROM participants
        WHERE user_id = ? AND completed = 1
    `).get(userId);

    res.json({ completedTasks: row.count });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
    res.send("Survey server running.");
});

fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        model: "gemma2:2b",
        messages: [{ role: "user", content: "hi" }]
    })
}).catch(err => console.error("Prewarm failed:", err));


app.post("/stop-stream", (req, res) => {
    const { userId, task, lang } = req.body;

    const sessionKey = getSessionKey(userId, task, lang);

    if (abortControllers[sessionKey]) {
        abortControllers[sessionKey].abort();
        delete abortControllers[sessionKey];
    }

    res.json({ status: "stopped" });
});

app.post("/count-words", (req, res) => {
    try {
        const { text } = req.body;

        if (typeof text !== "string") {
            return res.status(400).json({ count: 0 });
        }

        const cleaned = text.trim();

        if (!cleaned) {
            return res.json({ count: 0 });
        }

        // Match:
        // - CJK characters (Chinese, Japanese, Korean hanja/kanji/kana)
        // - Latin words
        const cjkRegex = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
        const latinRegex = /[a-zA-Z]+/g;

        let count = 0;

        // Count CJK characters individually
        const cjkMatches = cleaned.match(cjkRegex);
        if (cjkMatches) {
            count += cjkMatches.length;
        }

        // Count Latin words
        const latinMatches = cleaned.match(latinRegex);
        if (latinMatches) {
            count += latinMatches.length;
        }

        return res.json({ count });

    } catch (err) {
        console.error("count-words crash:", err);
        return res.status(200).json({ count: 0 });
    }
});

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});