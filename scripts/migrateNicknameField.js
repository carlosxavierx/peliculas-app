/**
 * Migración: dejar un único campo de apodo.
 *
 * Antes el apodo se guardaba duplicado: `users/{email}.nickname` y
 * `users/{email}.prefs.nickname`. Además el cuestionario de onboarding
 * reescribía `prefs` con los valores por defecto (`nickname: null`), así que el
 * documento acababa con DOS campos de apodo: uno con valor y otro a null.
 *
 * A partir de ahora el apodo vive SOLO en `users/{email}.nickname`.
 * Este script:
 *   1. Si solo existe `prefs.nickname`, lo copia a `nickname` (recupera apodos
 *      que se hubieran quedado únicamente en prefs).
 *   2. Elimina siempre `prefs.nickname`.
 *
 * Uso:
 *   node scripts/migrateNicknameField.js             # simulación (no escribe)
 *   node scripts/migrateNicknameField.js --confirm   # aplica los cambios
 */

const { FieldValue } = require("firebase-admin/firestore");
const firebaseConn = require("../src-backend/models/firebase");
const db = firebaseConn.getDb();

const APPLY = process.argv.includes("--confirm");

if (!db) {
    console.error("❌ Sin conexión a Firestore. Revisa tu .env (FIREBASE_*) o firebase-key.json.");
    process.exit(1);
}
console.log("🔥 Firestore conectado (" + firebaseConn.getMode() + ").");
console.log(APPLY ? "⚠️  Modo REAL: se aplicarán los cambios." : "🧪 Simulación: no se escribe nada (usa --confirm para aplicar).");

async function migrateNicknameField() {
    const snapshot = await db.collection("users").get();

    let revisados = 0;
    let conPrefsNickname = 0;
    let recuperados = 0;
    let limpiados = 0;

    for (const doc of snapshot.docs) {
        revisados += 1;
        const data = doc.data() || {};
        const prefs = data.prefs || {};
        // Solo nos interesan los documentos que tienen la copia duplicada.
        if (!Object.prototype.hasOwnProperty.call(prefs, "nickname")) continue;

        conPrefsNickname += 1;
        const rootNickname = String(data.nickname || "").trim();
        const prefNickname = String(prefs.nickname || "").trim().toLowerCase();

        const patch = { "prefs.nickname": FieldValue.delete() };
        let accion = "elimina prefs.nickname";
        if (!rootNickname && prefNickname) {
            patch.nickname = prefNickname;
            accion = "recupera prefs.nickname -> nickname y elimina prefs.nickname";
            recuperados += 1;
        } else {
            limpiados += 1;
        }

        console.log(`  • ${doc.id}: ${accion}${rootNickname ? ` (nickname: "${rootNickname}")` : ""}`);

        if (APPLY) {
            await doc.ref.update(patch);
        }
    }

    console.log("\n--- Resumen ---");
    console.log(`Usuarios revisados: ${revisados}`);
    console.log(`Con prefs.nickname: ${conPrefsNickname}`);
    console.log(`  - Apodo recuperado a la raíz: ${recuperados}`);
    console.log(`  - Copia de prefs eliminada: ${limpiados}`);
    if (!APPLY) {
        console.log("\n(nada escrito; vuelve a ejecutar con --confirm para aplicar los cambios)");
    }
}

migrateNicknameField()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Error durante la migración:", error);
        process.exit(1);
    });
