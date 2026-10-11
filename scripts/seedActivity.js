/**
 * Siembra la actividad reciente inicial del panel de administración para que no
 * aparezca vacío: convierte las últimas reseñas del catálogo en eventos y añade
 * un par de promociones a administrador históricas.
 *
 * Uso:
 *   node scripts/seedActivity.js          # escribe si la colección activity está vacía
 *   node scripts/seedActivity.js --force  # escribe aunque ya tenga datos (duplica)
 *
 * Los eventos que lleguen a partir de ahora (añadir reseña, cambiar rol) se
 * registran solos desde el backend en tiempo real.
 */
const firebaseConn = require("../src-backend/models/firebase");

const db = firebaseConn.getDb();
const force = process.argv.includes("--force");

if (!db) {
    console.error("Sin conexión a Firestore. Revisa FIREBASE_* en .env.");
    process.exit(1);
}

function isoDaysAgo(days, hour, minute) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
}

(async () => {
    const existing = await db.collection("activity").limit(1).get();
    if (!existing.empty && !force) {
        console.log("La colección activity ya tiene eventos; no se añade nada. (Usa --force para duplicar.)");
        process.exit(0);
    }

    const events = [];

    // 1) Los eventos de reseña más recientes, con fecha real de publicación.
    const snap = await db.collection("reviews").orderBy("createdAt", "desc").limit(6).get();
    snap.forEach((d) => {
        const data = d.data() || {};
        events.push({
            type: "review",
            actor: data.userName || "Usuario",
            target: data.mediaTitle || "una obra",
            details: String(data.text || "").replace(/\s+/g, " ").trim().slice(0, 100),
            at: data.createdAt || new Date().toISOString()
        });
    });

    // 2) Promociones históricas a administrador (padres del equipo).
    events.push(
        {
            type: "promote",
            actor: "Carlos Xavier",
            target: "Daniel García",
            details: "",
            at: isoDaysAgo(3, 10, 30)
        },
        {
            type: "promote",
            actor: "Pablo Rodríguez",
            target: "María López",
            details: "",
            at: isoDaysAgo(9, 16, 15)
        }
    );

    const wb = db.batch();
    events.forEach((e) => wb.set(db.collection("activity").doc(), e));
    await wb.commit();

    console.log(`Actividad sembrada: ${events.length} eventos (${events.filter((e) => e.type === "review").length} reseñas + ${events.filter((e) => e.type === "promote").length} promociones).`);
    process.exit(0);
})().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
});