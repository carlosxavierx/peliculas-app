/**
 * Pósteres del catálogo: comprobar y reparar.
 *
 *   node scripts/repairPosters.js           -> informe (cuántos cargan y cuáles no)
 *   node scripts/repairPosters.js --apply   -> repara los que OMDb pueda renovar
 *
 * Nota: los enlaces muertos suelen estar borrados del CDN de Amazon; solo se
 * pueden renovar si OMDB_API_KEY (.env) es una clave válida (la de ejemplo no
 * sirve). A los que sigan sin póster la web les dibuja uno propio con sus datos
 * (función posterArtwork de public/js/bundle.js).
 */
const fs = require("fs");
const path = require("path");

function loadEnvFile() {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const i = t.indexOf("=");
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(k in process.env)) process.env[k] = v;
    }
}
loadEnvFile();

const firebaseConn = require("../src-backend/models/firebase");
const { omdbService } = require("../src-backend/services/omdbService");
const db = firebaseConn.getDb();
const APLICAR = process.argv.includes("--apply");

async function status(url) {
    try {
        const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
        if (res.body && res.body.cancel) { try { res.body.cancel(); } catch (e) {} }
        return res.status;
    } catch (e) {
        return 0;
    }
}

(async () => {
    const docs = [];
    for (const col of ["movies", "series"]) {
        const snap = await db.collection(col).limit(20000).get();
        snap.forEach((d) => docs.push({ col, id: d.id, ref: d.ref, ...(d.data() || {}) }));
    }

    // 1) Comprobar los que tienen póster.
    const conPoster = docs.filter((d) => d.poster && String(d.poster).trim() && !/N\/A/i.test(String(d.poster)));
    const aRevisar = [];
    let idx = 0;
    async function worker() {
        while (idx < conPoster.length) {
            const d = conPoster[idx++];
            const st = await status(String(d.poster));
            if (st !== 200) aRevisar.push({ ...d, motivo: "HTTP " + st });
        }
    }
    await Promise.all(Array.from({ length: 10 }, worker));

    // 2) Los que no tienen póster.
    const sinPoster = docs.filter((d) => !d.poster || /N\/A/i.test(String(d.poster)))
        .map((d) => ({ ...d, motivo: "sin póster" }));

    const pendientes = [...aRevisar, ...sinPoster];
    console.log(`Documentos: ${docs.length} · con póster que carga: ${conPoster.length - aRevisar.length}`);
    console.log(`Póster roto: ${aRevisar.length} · sin póster: ${sinPoster.length} · total a reparar: ${pendientes.length}`);

    if (!APLICAR) {
        console.log("\nEjemplos:");
        pendientes.slice(0, 12).forEach((d) => console.log(`   [${d.motivo}] ${d.col} · ${d.title || d.id}`));
        console.log("\nPara intentar repararlos: node scripts/repairPosters.js --apply");
        process.exit(0);
    }

    // 3) Reparar con OMDb (necesita una clave válida).
    let reparados = 0, sinMejora = 0, errores = 0;
    for (const d of pendientes) {
        if (!d.imdbID) { sinMejora++; continue; }
        try {
            const datos = await omdbService.getById(d.imdbID);
            const nuevo = datos.Poster && datos.Poster !== "N/A" ? datos.Poster : null;
            if (!nuevo || (d.poster && nuevo === d.poster) || (await status(nuevo)) !== 200) {
                sinMejora++;
                continue;
            }
            await d.ref.update({
                poster: nuevo,
                posterOriginal: d.poster || null,
                posterFixedAt: new Date().toISOString()
            });
            reparados++;
            console.log(`   ✔ ${d.title || d.id}`);
        } catch (e) {
            errores++;
            if (errores <= 3) console.warn(`   ✖ ${d.title || d.id}: ${e.message || e}`);
        }
        await new Promise((r) => setTimeout(r, 250)); // respeta la cuota de OMDb
    }
    console.log(`\nReparados: ${reparados} · sin mejora posible: ${sinMejora} · errores: ${errores}`);
    process.exit(0);
})().catch((e) => { console.error("Error:", e.message || e); process.exit(1); });
