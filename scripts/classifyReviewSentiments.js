/**
 * Clasifica el sentimiento de las reseñas existentes usando la IA de Google
 * (Gemini) sobre su texto y guarda la etiqueta en el campo `sentiment` de cada
 * reseña. Es idempotente: por defecto solo procesa las reseñas que aún no
 * tienen etiqueta (para re-etiquetar todas usa --force).
 *
 * Uso:
 *   node scripts/classifyReviewSentiments.js            # solo reseñas sin etiqueta
 *   node scripts/classifyReviewSentiments.js --force     # reclasifica todas
 *   node scripts/classifyReviewSentiments.js --limit=20  # máximo de reseñas a procesar
 *
 * Requiere GEMINI_API_KEY en .env (ver .env.example).
 */
// Carga mínima de .env (igual que server.js) ANTES de requerir los servicios,
// porque leen process.env al importarse.
const fs = require("fs");
const path = require("path");

function loadEnvFile() {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const idx = trimmed.indexOf("=");
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnvFile();

const firebaseConn = require("../src-backend/models/firebase");
const geminiService = require("../src-backend/services/geminiService");

const db = firebaseConn.getDb();
const args = process.argv.slice(2);
const force = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const maxProcess = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) || 0 : 0;

(async () => {
    if (!geminiService.isConfigured()) {
        console.error("GEMINI_API_KEY no definida. Añádela a .env y reinicia el servidor.");
        process.exit(1);
    }
    if (!db) {
        console.error("Firestore no está conectado.");
        process.exit(1);
    }
    console.log(`Modelo Gemini: ${process.env.GEMINI_MODEL || process.env.CHAT_MODEL || "gemini-3.8-flash"}`);

    const snap = await db.collection("reviews").limit(20000).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const pending = docs
        .filter((d) => force || !d.sentiment)
        .slice(0, maxProcess || undefined);

    console.log(`Total reseñas: ${docs.length} · a clasificar: ${pending.length}`);
    if (pending.length === 0) {
        console.log("Nada que hacer. (Usa --force para reclasificar todas.)");
        process.exit(0);
    }

    let updated = 0;
    let skipped = 0;
    const step = 40;
    for (let i = 0; i < pending.length; i += step) {
        const batch = pending.slice(i, i + step);
        const labels = await geminiService.classifyTexts(batch.map((d) => d.text || ""));
        const writes = [];
        batch.forEach((doc, j) => {
            const label = labels && labels[j];
            if (label) writes.push({ id: doc.id, label });
            else skipped += 1;
        });
        if (writes.length > 0) {
            const wb = db.batch();
            const now = new Date().toISOString();
            writes.forEach((w) =>
                wb.set(
                    db.collection("reviews").doc(w.id),
                    { sentiment: w.label, sentimentAt: now },
                    { merge: true }
                )
            );
            await wb.commit();
            updated += writes.length;
        }
        console.log(`  Lote ${i / step + 1}: ${writes.length} clasificadas de ${batch.length}`);
        await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`Hecho: ${updated} reseñas etiquetadas, ${skipped} omitidas.`);
    process.exit(0);
})().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
});