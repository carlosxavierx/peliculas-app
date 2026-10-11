// Modelo de actividad reciente para el panel de administración.
//
// Colección Firestore: activity/{eventId}
//   { type: "review" | "promote" | "demote" | "generic",
//     actor: quien realiza la acción,
//     target: sobre qué (obra, usuario),
//     details: texto libre opcional,
//     at:     fecha ISO }
//
// El panel consulta estos eventos en /api/admin/stats (campo "activity") y se
// registran en cada acción relevante (añadir una review, cambiar un rol).
// Todo es best-effort: si falla, no rompe la acción principal.
const firebaseConn = require("./firebase");

function sanitize(raw) {
    return String(raw == null ? "" : raw)
        .replace(/\r\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function addEvent({ type, actor, target, details }) {
    const db = firebaseConn.getDb();
    if (!db) return null;
    const event = {
        type: type === "review" || type === "promote" || type === "demote" ? type : "generic",
        actor: sanitize(actor).slice(0, 80) || "Usuario",
        target: sanitize(target).slice(0, 120),
        details: sanitize(details).slice(0, 220),
        at: new Date().toISOString()
    };
    try {
        await db.collection("activity").add(event);
    } catch (error) {
        console.error("[activity] No se pudo registrar el evento:", error.message || error);
    }
    return event;
}

async function listRecent(limit) {
    const db = firebaseConn.getDb();
    if (!db) return [];
    const max = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 20);
    try {
        const snap = await db.collection("activity").orderBy("at", "desc").limit(max).get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (error) {
        console.error("[activity] No se pudo leer la actividad:", error.message || error);
        return [];
    }
}

module.exports = { addEvent, listRecent };