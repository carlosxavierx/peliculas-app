/**
 * Renombra las reseñas de prueba que tienen autor "Cinefilo Seed NNNN" a
 * nombres y apellidos reales (deterministas, mismos que usa seedReviews.js),
 * para que el panel de administración no parezca una base de pruebas.
 *
 * Uso:
 *   node scripts/assignRealReviewNames.js          # actualiza las que coinciden
 *   node scripts/assignRealReviewNames.js --dry-run # solo muestra qué cambiaría
 *
 * Es idempotente y re-ejecutable: identifica las reseñas sembradas por su
 * userName ("Cinefilo Seed NNNN") o, una vez renombradas, por su userId
 * ("seed_user_NNNN"), y les asigna el nombre real correspondiente.
 */
const firebaseConn = require("../src-backend/models/firebase");
const { realUserName } = require("./seedReviews");

const db = firebaseConn.getDb();
const dryRun = process.argv.includes("--dry-run");

if (!db) {
    console.error("Sin conexión a Firestore. Revisa FIREBASE_* en .env.");
    process.exit(1);
}

const SEED_NAME = /^Cinefilo Seed\s+(\d+)$/i;
const SEED_USER_ID = /^seed_user_(\d+)$/i;

// Obtiene el índice original de la reseña sembrada: primero por el userName
// ("Cinefilo Seed NNNN") y, si ya tiene nombre real, por el userId sembrado.
function seedIndex(data) {
    const byName = SEED_NAME.exec(String(data.userName || "").trim());
    if (byName) return parseInt(byName[1], 10);
    const byId = SEED_USER_ID.exec(String(data.userId || "").trim());
    if (byId) return parseInt(byId[1], 10);
    return null;
}

(async () => {
    const snap = await db.collection("reviews").limit(20000).get();
    const toUpdate = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const number = seedIndex(data);
        if (number == null) return;
        const newName = realUserName(number);
        if (newName && newName !== data.userName) {
            toUpdate.push({ id: d.id, from: data.userName, to: newName });
        }
    });

    console.log(`Reviews totales: ${snap.size} · con autor "Cinefilo Seed": ${toUpdate.length}`);

    if (dryRun) {
        toUpdate.slice(0, 12).forEach((u) => console.log(`  ${u.from}  ->  ${u.to}`));
        if (toUpdate.length > 12) console.log(`  … y ${toUpdate.length - 12} más.`);
        console.log("(--dry-run: no se ha modificado nada.)");
        process.exit(0);
    }

    let updated = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < toUpdate.length; i += 400) {
        const slice = toUpdate.slice(i, i + 400);
        const wb = db.batch();
        slice.forEach((u) =>
            wb.update(db.collection("reviews").doc(u.id), { userName: u.to, updatedAt: now })
        );
        await wb.commit();
        updated += slice.length;
        console.log(`  Lote ${i / 400 + 1}: ${slice.length} renombradas`);
    }
    console.log(`Hecho: ${updated} reseñas con nombre real.`);
    process.exit(0);
})().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
});