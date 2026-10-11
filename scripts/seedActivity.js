/**
 * Siembra la actividad reciente inicial del panel de administración a partir de
 * datos REALES del catálogo: convierte en eventos las últimas reseñas publicadas
 * (con el autor, la obra y el texto que ya existen en Firestore).
 *
 * No inventa promociones ni usuarios: los cambios de rol reales se registran
 * solos desde el backend en cuanto ocurren.
 *
 * Uso:
 *   node scripts/seedActivity.js          # escribe si la colección activity está vacía
 *   node scripts/seedActivity.js --force  # escribe aunque ya tenga datos (duplica)
 *   node scripts/seedActivity.js --reset  # borra TODA la actividad y la vuelve a sembrar
 *   node scripts/seedActivity.js --clean  # borra eventos de rol que citan usuarios inexistentes
 *
 * Los eventos que lleguen a partir de ahora (añadir reseña, cambiar rol) se
 * registran solos desde el backend en tiempo real.
 */
const firebaseConn = require("../src-backend/models/firebase");

const db = firebaseConn.getDb();
const force = process.argv.includes("--force");
const clean = process.argv.includes("--clean");
const reset = process.argv.includes("--reset");

if (!db) {
    console.error("Sin conexión a Firestore. Revisa FIREBASE_* en .env.");
    process.exit(1);
}

(async () => {
    // Limpieza: elimina eventos de rol (promote/demote) que apuntan a usuarios que
    // no existen en el sistema, es decir, datos inventados. Un evento real siempre
    // cita a un usuario que existe.
    if (clean) {
        const usersSnap = await db.collection("users").get();
        const known = new Set();
        usersSnap.forEach((d) => {
            const u = d.data() || {};
            if (u.name) known.add(String(u.name));
            if (u.nickname) known.add(String(u.nickname));
        });
        const actSnap = await db.collection("activity").get();
        const wb = db.batch();
        let removed = 0;
        actSnap.forEach((d) => {
            const e = d.data() || {};
            const isRole = e.type === "promote" || e.type === "demote";
            if (isRole && !known.has(String(e.target))) {
                wb.delete(d.ref);
                removed++;
            }
        });
        await wb.commit();
        console.log(`Limpieza: ${removed} evento(s) inventado(s) eliminado(s).`);
        process.exit(0);
    }

    // Reseteo: vacía la colección para volver a sembrarla solo con datos reales.
    if (reset) {
        const actSnap = await db.collection("activity").get();
        const wb = db.batch();
        actSnap.forEach((d) => wb.delete(d.ref));
        await wb.commit();
        console.log(`Reseteo: ${actSnap.size} evento(s) borrado(s).`);
    }

    const existing = await db.collection("activity").limit(1).get();
    if (!existing.empty && !force && !reset) {
        console.log("La colección activity ya tiene eventos; no se añade nada. (Usa --force para duplicar.)");
        process.exit(0);
    }

    const events = [];

    // 1) Los eventos de reseña más recientes. Se prioriza la última reseña de cada
    //    obra distinta y, si no hay obras suficientes, se completan con las reseñas
    //    más recientes restantes. Siempre con autor, obra y fecha reales.
    const snap = await db.collection("reviews").orderBy("createdAt", "desc").limit(300).get();
    const ordered = snap.docs
        .map((d) => {
            const data = d.data() || {};
            return {
                id: d.id,
                work: data.mediaTitle || "una obra",
                actor: data.userName || "Usuario",
                details: String(data.text || "").replace(/\s+/g, " ").trim().slice(0, 100),
                at: data.createdAt || new Date().toISOString()
            };
        })
        .filter((r) => r.at); // sin fecha no es un evento válido

    const toEvent = (r) => ({ type: "review", actor: r.actor, target: r.work, details: r.details, at: r.at });
    const usedIds = new Set();
    const seenWorks = new Set();

    // Primera pasada: una reseña (la más reciente) por cada obra distinta.
    for (const r of ordered) {
        if (events.length >= 6) break;
        if (seenWorks.has(r.work)) continue;
        seenWorks.add(r.work);
        usedIds.add(r.id);
        events.push(toEvent(r));
    }
    // Segunda pasada: completar con las reseñas más recientes restantes.
    for (const r of ordered) {
        if (events.length >= 6) break;
        if (usedIds.has(r.id)) continue;
        usedIds.add(r.id);
        events.push(toEvent(r));
    }

    const wb = db.batch();
    events.forEach((e) => wb.set(db.collection("activity").doc(), e));
    await wb.commit();

    console.log(`Actividad sembrada: ${events.length} eventos (todos reseñas reales del catálogo).`);
    process.exit(0);
})().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
});
