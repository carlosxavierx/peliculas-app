/**
 * Traduce al castellano las sinopsis (campo `plot`) que el catálogo trae en
 * inglés desde OMDb, y guarda el resultado en Firestore.
 *
 * Por cada documento se guarda:
 *   - plot:         la sinopsis en castellano (lo que muestra la web).
 *   - plotOriginal: la sinopsis original en inglés (para no perder el dato).
 *   - plotLang:     "es" (marca para no volver a traducirla).
 *
 * Es idempotente: los documentos ya marcados con plotLang "es" se omiten, así
 * que se puede relanzar sin gastar cuota de más (solo reintenta lo que falle).
 *
 * Uso:
 *   node scripts/translatePlots.js                  # traduce todo lo pendiente
 *   node scripts/translatePlots.js --dry-run        # solo cuenta, no traduce
 *   node scripts/translatePlots.js --limit=20       # máximo de sinopsis únicas
 *   node scripts/translatePlots.js --col=series     # solo una colección
 *
 * Requiere GEMINI_API_KEY y credenciales Firebase en .env.
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
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const maxUnique = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) || 0 : 0;
const colArg = args.find((a) => a.startsWith("--col="));
const onlyCol = colArg ? colArg.split("=")[1].trim() : null;

const PLACEHOLDER = "Sin sinopsis disponible.";
const SENTENCE_BATCH = 10;   // sinopsis únicas por llamada a la IA (ritmo controlado)
const WRITE_BATCH = 400;     // escrituras por lote de Firestore
const PAUSE_MS = 4500;       // pausa entre llamadas (respeta el límite por minuto)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    if (!geminiService.isConfigured()) {
        console.error("GEMINI_API_KEY no definida. Añádela a .env.");
        process.exit(1);
    }
    if (!db) {
        console.error("Firestore no está conectado. Revisa FIREBASE_* en .env.");
        process.exit(1);
    }

    const collections = onlyCol ? [onlyCol] : ["movies", "series"];
    console.log(`Modelo Gemini (traducción): ${process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-flash-lite"}`);
    console.log(`Colecciones: ${collections.join(", ")}`);

    // 1) Recopilar documentos pendientes de traducir.
    const targets = [];
    for (const col of collections) {
        const snap = await db.collection(col).limit(20000).get();
        snap.forEach((doc) => {
            const data = doc.data() || {};
            const plot = String(data.plot || "").trim();
            if (data.plotLang === "es") return;              // ya traducido
            if (!plot || plot === PLACEHOLDER) return;        // sin sinopsis real
            targets.push({ ref: doc.ref, col, original: plot });
        });
        console.log(`  ${col}: ${snap.size} documentos leídos`);
    }

    // Deduplicar por texto: la misma sinopsis se traduce una sola vez.
    const uniqueTexts = [...new Set(targets.map((t) => t.original))];
    if (maxUnique > 0) uniqueTexts.length = Math.min(uniqueTexts.length, maxUnique);
    console.log(`Documentos pendientes: ${targets.length} · sinopsis únicas a traducir: ${uniqueTexts.length}`);
    if (uniqueTexts.length === 0) {
        console.log("Nada que traducir. Todo el catálogo ya está en castellano.");
        process.exit(0);
    }
    if (dryRun) {
        console.log("Dry-run: no se llamará a la IA ni se escribirá en Firestore.");
        process.exit(0);
    }

    // 2) Traducir las sinopsis únicas.
    const translations = new Map(); // inglés → castellano
    for (let i = 0; i < uniqueTexts.length; i += SENTENCE_BATCH) {
        const slice = uniqueTexts.slice(i, i + SENTENCE_BATCH);
        const result = await geminiService.translateTexts(slice);
        slice.forEach((text, j) => {
            const value = result && result[j];
            if (value) translations.set(text, value);
        });
        console.log(`  Traducidas ${translations.size}/${uniqueTexts.length}`);
        await delay(PAUSE_MS);
    }
    if (translations.size === 0) {
        console.log("La IA no devolvió ninguna traducción. Revisa GEMINI_API_KEY / cuota.");
        process.exitCode = 1;
        process.exit(1);
    }

    // 3) Escribir las traducciones en Firestore.
    const updates = targets.filter((t) => translations.has(t.original));
    let written = 0;
    for (let i = 0; i < updates.length; i += WRITE_BATCH) {
        const chunk = updates.slice(i, i + WRITE_BATCH);
        const batch = db.batch();
        chunk.forEach((u) => {
            batch.update(u.ref, {
                plot: translations.get(u.original),
                plotOriginal: u.original,
                plotLang: "es"
            });
        });
        await batch.commit();
        written += chunk.length;
        console.log(`  Escritos ${written}/${updates.length}`);
    }

    const skipped = targets.length - updates.length;
    console.log(`Hecho. Documentos actualizados: ${updates.length} (sinopsis únicas traducidas: ${translations.size}).`);
    if (skipped > 0) {
        console.log(`Ojo: ${skipped} documentos siguen en inglés (la IA no devolvió su traducción). Relanza el script.`);
    }
    process.exit(0);
})().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
});
