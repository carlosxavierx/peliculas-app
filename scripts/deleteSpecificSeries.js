/**
 * Borra una serie específica de Firestore por título exacto o parcial.
 *
 * Uso:
 *   node scripts/deleteSpecificSeries.js "Willow Harper - ASMR Reactions" --confirm
 *   node scripts/deleteSpecificSeries.js "Willow Harper" --confirm --dry-run
 */

const firebaseConn = require("../src-backend/models/firebase");
const db = firebaseConn.getDb();
const args = process.argv.slice(2);

if (!db) {
    console.error("Sin conexión a Firestore. Revisa FIREBASE_* en .env.");
    process.exit(1);
}

const titleArg = args.find(a => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const confirmed = args.includes("--confirm");

if (!titleArg) {
    console.error("Uso: node scripts/deleteSpecificSeries.js \"Título\" [--dry-run] [--confirm]");
    process.exit(1);
}

if (!confirmed) {
    console.error("Operación cancelada: añade --confirm para borrar.");
    process.exit(1);
}

async function deleteSeries() {
    try {
        // Buscar por título (case-insensitive, búsqueda parcial)
        const snapshot = await db.collection("series")
            .where("title", ">=", titleArg)
            .where("title", "<=", titleArg + "\uf8ff")
            .get();

        if (snapshot.empty) {
            console.log(`No se encontraron series que empiecen con: "${titleArg}"`);
            // Búsqueda más amplia
            const allSnapshot = await db.collection("series").get();
            const matches = [];
            allSnapshot.docs.forEach(doc => {
                const data = doc.data();
                if (data.title && data.title.toLowerCase().includes(titleArg.toLowerCase())) {
                    matches.push({ id: doc.id, ...data });
                }
            });
            if (matches.length > 0) {
                console.log("Coincidencias parciales encontradas:");
                matches.forEach(m => console.log(`  - ${m.title} (ID: ${m.id}, año: ${m.year})`));
            } else {
                console.log("No hay coincidencias parciales tampoco.");
            }
            return;
        }

        console.log(`Encontradas ${snapshot.size} serie(s) con título que empieza por "${titleArg}":`);
        const toDelete = [];
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            console.log(`  - ${data.title} (ID: ${doc.id}, año: ${data.year})`);
            toDelete.push(doc);
        });

        if (dryRun) {
            console.log(`\nDry-run: se borrarían ${toDelete.length} serie(s).`);
            return;
        }

        for (let i = 0; i < toDelete.length; i += 450) {
            const batch = db.batch();
            toDelete.slice(i, i + 450).forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }

        console.log(`\nBorradas ${toDelete.length} serie(s) correctamente.`);
    } catch (error) {
        console.error("Error:", error.message || error);
        process.exitCode = 1;
    }
}

deleteSeries();