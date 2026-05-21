import "dotenv/config";
import { Bot, Context } from "grammy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Load bot token from environment
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN)
    throw new Error("Missing BOT_TOKEN in .env file");
// Create an instance of the `Bot` class and pass your bot token to it.
const bot = new Bot(BOT_TOKEN);
// State persistence setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, "state.json");
const defaultState = {
    ownerId: null,
    status: "OFFLINE",
    offlineSince: Date.now(),
    eta: "UNKNOWN",
    reason: "NOT SPECIFIED",
};
let state = { ...defaultState };
// Per-user cooldown: tracks the last time we auto-replied to each user (userId -> timestamp)
// Resets when the owner goes back online so the next offline period starts fresh
const COOLDOWN_MS = 1 * 60 * 1000; // 5 minutes
const repliedUsers = new Map();
async function loadState() {
    try {
        const data = await fs.readFile(STATE_FILE, "utf-8");
        const loaded = JSON.parse(data);
        // Merge with defaultState so any newly added fields always have a fallback
        state = { ...defaultState, ...loaded };
        console.log("Loaded state:", state);
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            console.error("Error loading state:", error);
        }
        else {
            console.log("State file not found. Initializing with default state.");
            await saveState();
        }
    }
}
async function saveState() {
    try {
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    }
    catch (error) {
        console.error("Error saving state:", error);
    }
}
// Escape special HTML characters in user-supplied strings
// Coerces to string first so it never crashes on undefined/null
function htmlEscape(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
// Format duration for LAST SEEN field
function formatLastSeen(offlineSince) {
    if (!offlineSince)
        return "UNKNOWN";
    const diffMs = Date.now() - offlineSince;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 5) {
        return "RECENTLY";
    }
    if (diffMins < 60) {
        return `${diffMins} MINUTES AGO`;
    }
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) {
        return `${diffHours} ${diffHours === 1 ? "HOUR" : "HOURS"} AGO`;
    }
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} ${diffDays === 1 ? "DAY" : "DAYS"} AGO`;
}
// Helper to check if sender is owner
function isSenderOwner(ctx) {
    if (!ctx.from)
        return false;
    // Check against loaded state ownerId
    if (state.ownerId && ctx.from.id === state.ownerId) {
        return true;
    }
    // Check against env variable fallback
    const envOwnerId = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID, 10) : null;
    if (envOwnerId && ctx.from.id === envOwnerId) {
        state.ownerId = envOwnerId;
        saveState();
        return true;
    }
    return false;
}
// Commands
bot.command("start", async (ctx) => {
    if (!ctx.from)
        return;
    if (isSenderOwner(ctx)) {
        await ctx.reply(`👋 Welcome back!\n\n` +
            `Here are your commands:\n` +
            `🔴 /offline [ETA] — Go offline (e.g. /offline 2 hours)\n` +
            `🟢 /online — Come back online\n` +
            `📊 /status — View current bot status`);
        return;
    }
    if (!state.ownerId) {
        state.ownerId = ctx.from.id;
        await saveState();
        await ctx.reply(`👋 Hello! You've been registered as the Bot Owner.\n` +
            `🆔 Your ID: ${ctx.from.id}\n\n` +
            `Available commands:\n` +
            `🔴 /offline [ETA] — Set status to OFFLINE (e.g. /offline 2 hours)\n` +
            `🟢 /online — Set status to ONLINE\n` +
            `📊 /status — Check current bot status`);
        return;
    }
    await ctx.reply("Hello! This is a Telegram Business helper bot.");
});
bot.command("online", async (ctx) => {
    if (!isSenderOwner(ctx))
        return;
    state.status = "ONLINE";
    state.offlineSince = null;
    await saveState();
    // Reset cooldowns so fresh replies go out when offline again
    repliedUsers.clear();
    await ctx.reply(`🟢 <b>You're now ONLINE</b>\n` +
        `<blockquote>📡 STATUS     : <b>ONLINE</b>\n🤖 RESPONDER : <b>DISABLED</b></blockquote>\n` +
        `Customers will no longer receive automated replies.`, { parse_mode: "HTML" });
});
bot.command("offline", async (ctx) => {
    if (!isSenderOwner(ctx))
        return;
    // Parse: /offline [ETA] | [reason]
    const raw = ctx.match?.trim() || "";
    const [etaPart, ...reasonParts] = raw.split("|");
    state.status = "OFFLINE";
    state.offlineSince = Date.now();
    state.eta = etaPart?.trim() || "UNKNOWN";
    state.reason = reasonParts.join("|").trim() || "NOT SPECIFIED";
    await saveState();
    await ctx.reply(`🔴 <b>You're now OFFLINE</b>\n` +
        `<blockquote>📡 STATUS     : <b>OFFLINE</b>\n` +
        `⏱️ ETA        : <b>${htmlEscape(state.eta.toUpperCase())}</b>\n` +
        `📝 REASON     : <b>${htmlEscape(state.reason)}</b>\n` +
        `📅 SINCE      : <b>JUST NOW</b>\n` +
        `🤖 RESPONDER : <b>ACTIVE</b></blockquote>\n` +
        `Customers will now receive automated replies.`, { parse_mode: "HTML" });
});
bot.command("status", async (ctx) => {
    if (!isSenderOwner(ctx))
        return;
    const lastSeenStr = state.status === "OFFLINE" ? formatLastSeen(state.offlineSince) : "N/A";
    const offlineSinceStr = state.offlineSince
        ? new Date(state.offlineSince).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true })
        : "N/A";
    const statusEmoji = state.status === "ONLINE" ? "🟢" : "🔴";
    await ctx.reply(`📊 <b>Bot Status Report</b>\n` +
        `<blockquote>${statusEmoji} STATUS     : <b>${state.status}</b>\n` +
        `⏱️ ETA        : <b>${htmlEscape(state.eta.toUpperCase())}</b>\n` +
        `📝 REASON     : <b>${htmlEscape(state.reason)}</b>\n` +
        `📅 SINCE      : <b>${offlineSinceStr}</b>\n` +
        `📡 LAST SEEN  : <b>${lastSeenStr}</b>\n` +
        `🤖 RESPONDER : <b>${state.status === "OFFLINE" ? "ACTIVE" : "DISABLED"}</b></blockquote>`, { parse_mode: "HTML" });
});
// Capture business connection info when established
bot.on("business_connection", async (ctx) => {
    const conn = ctx.businessConnection;
    if (conn.is_enabled) {
        state.ownerId = conn.user.id;
        await saveState();
        console.log(`Successfully connected and bound to business owner: ${conn.user.first_name} (ID: ${conn.user.id})`);
    }
});
// Business Message Auto-Responder
bot.on("business_message").filter(async (ctx) => {
    const conn = await ctx.getBusinessConnection();
    // Auto-capture ownerId if not set yet
    if (!state.ownerId) {
        state.ownerId = conn.user.id;
        await saveState();
    }
    return ctx.from.id !== conn.user.id;
}, async (ctx) => {
    // Only auto-reply when OFFLINE
    if (state.status !== "OFFLINE") {
        return;
    }
    if (ctx.msg.text) {
        const userId = ctx.from.id;
        const lastReplied = repliedUsers.get(userId) ?? 0;
        const now = Date.now();
        // Skip if this user already got a reply within the cooldown window
        if (now - lastReplied < COOLDOWN_MS) {
            return;
        }
        repliedUsers.set(userId, now);
        const lastSeen = formatLastSeen(state.offlineSince);
        await ctx.reply(`<a href="https://t.me/nohello/4">⚡</a> <b>AUTOMATED RESPONSE</b>\n` +
            `<blockquote>🔴 STATUS     : <b>OFFLINE</b>\n` +
            `⏱️ ETA        : <b>${htmlEscape(state.eta.toUpperCase())}</b>\n` +
            `📝 REASON     : <b>${htmlEscape(state.reason)}</b>\n` +
            `📡 LAST SEEN  : <b>${lastSeen}</b></blockquote>`, {
            parse_mode: "HTML",
            link_preview_options: { url: "https://t.me/nohello/4" },
        });
    }
});
// Global error handler — log the error but keep the bot running
bot.catch((err) => {
    console.error("[BOT ERROR] Update:", err.ctx.update.update_id);
    console.error(err.error);
});
// Load state and start bot
await loadState();
bot.start();
//# sourceMappingURL=bot.js.map